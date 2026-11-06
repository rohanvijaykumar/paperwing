// paperwing-scan: Paperwing's scanner helper for macOS (see desktop/scan.cjs).
// Apple's ImageCaptureCore, so USB and network (AirScan) scanners that work
// in Image Capture work here. One JSON object per line on stdout.
//
//   paperwing-scan list
//   paperwing-scan caps -DeviceId <id>
//   paperwing-scan scan -DeviceId <id> -OutDir <folder> -Options <base64 JSON>
//
// Built universal (Apple silicon and Intel) by build.sh.
import Foundation
import ImageCaptureCore

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
    var line = String(data: data, encoding: .utf8)
  else { return }
  line += "\n"
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message])
  exit(2)
}

// Arguments: a command, then -Name value pairs
let argv = CommandLine.arguments
let command = argv.count > 1 ? argv[1] : ""
var named: [String: String] = [:]
var i = 2
while i + 1 < argv.count {
  named[argv[i].lowercased()] = argv[i + 1]
  i += 2
}

struct ScanOptions {
  var source = "flatbed"
  var duplex = false
  var color = "color"
  var dpi = 300
  var width = 8.5
  var height = 11.0
}

func readOptions() -> ScanOptions {
  var o = ScanOptions()
  guard let b64 = named["-options"], let data = Data(base64Encoded: b64),
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return o }
  if let v = json["source"] as? String { o.source = v }
  if let v = json["duplex"] as? Bool { o.duplex = v }
  if let v = json["color"] as? String { o.color = v }
  if let v = json["dpi"] as? Int { o.dpi = v }
  if let v = json["width"] as? Double { o.width = v }
  if let v = json["height"] as? Double { o.height = v }
  return o
}

/// The feeder's paper for a size in inches (it scans whole sheets)
func documentType(width: Double, height: Double) -> ICScannerDocumentType {
  let near = { (a: Double, b: Double) in abs(a - b) < 0.2 }
  if near(width, 8.5) && near(height, 11) { return .typeUSLetter }
  if near(width, 8.5) && near(height, 14) { return .typeUSLegal }
  if near(width, 8.27) && near(height, 11.69) { return .typeA4 }
  if near(width, 5.83) && near(height, 8.27) { return .typeA5 }
  return .typeDefault
}

final class Helper: NSObject, ICDeviceBrowserDelegate, ICScannerDeviceDelegate {
  let browser = ICDeviceBrowser()
  var found: [ICScannerDevice] = []
  var target: ICScannerDevice?
  var pendingUnits: [ICScannerFunctionalUnitType] = []
  var sources: [[String: Any]] = []
  var options = ScanOptions()
  var pages = 0

  func start() {
    browser.delegate = self
    // Scanners connected by USB, shared, and on the network (Bonjour)
    browser.browsedDeviceTypeMask =
      ICDeviceTypeMask(
        rawValue: ICDeviceTypeMask.scanner.rawValue
          | ICDeviceLocationTypeMask.local.rawValue
          | ICDeviceLocationTypeMask.shared.rawValue
          | ICDeviceLocationTypeMask.bonjour.rawValue
      ) ?? .scanner
    browser.start()
    switch command {
    case "list":
      // Network scanners take a moment to answer
      DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
        emit([
          "type": "scanners",
          "scanners": self.found.map {
            ["id": $0.uuidString ?? $0.name ?? "", "name": $0.name ?? "Scanner"]
          },
        ])
        exit(0)
      }
    case "caps", "scan":
      if command == "scan" { options = readOptions() }
      DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
        if self.target == nil { fail("no-scanner", "Scanner not found") }
      }
    default:
      fail("failed", "Unknown command: \(command)")
    }
  }

  // MARK: Finding the scanner

  func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
    guard let scanner = device as? ICScannerDevice else { return }
    found.append(scanner)
    guard command != "list", target == nil,
      let id = named["-deviceid"],
      scanner.uuidString == id || scanner.name == id
    else { return }
    target = scanner
    scanner.delegate = self
    scanner.requestOpenSession()
  }

  func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
    found.removeAll { $0 === device }
  }

  func didRemove(_ device: ICDevice) {
    if device === target { fail("offline", "The scanner was disconnected") }
  }

  func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {
    if let error = error { fail("busy", error.localizedDescription) }
    guard let scanner = target else { return }
    let types = scanner.availableFunctionalUnitTypes.compactMap {
      ICScannerFunctionalUnitType(rawValue: $0.uintValue)
    }
    if command == "caps" {
      pendingUnits = types.filter { $0 == .flatbed || $0 == .documentFeeder }
      if pendingUnits.isEmpty { pendingUnits = [scanner.selectedFunctionalUnit.type] }
      scanner.requestSelect(pendingUnits.removeFirst())
    } else {
      let want: ICScannerFunctionalUnitType =
        options.source == "feeder" ? .documentFeeder : .flatbed
      if !types.contains(want) && !(types.isEmpty && want == .flatbed) {
        fail("failed", "This scanner has no \(options.source == "feeder" ? "document feeder" : "flatbed")")
      }
      scanner.requestSelect(want)
    }
  }

  func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}

  // MARK: What it can do, and scanning

  func scannerDevice(
    _ scanner: ICScannerDevice, didSelect functionalUnit: ICScannerFunctionalUnit, error: Error?
  ) {
    if let error = error { fail("busy", error.localizedDescription) }
    if command == "caps" {
      sources.append(describe(functionalUnit))
      if pendingUnits.isEmpty {
        emit(["type": "caps", "sources": sources])
        scanner.requestCloseSession()
        exit(0)
      }
      scanner.requestSelect(pendingUnits.removeFirst())
      return
    }
    configure(scanner, functionalUnit)
    scanner.requestScan()
  }

  func describe(_ fu: ICScannerFunctionalUnit) -> [String: Any] {
    fu.measurementUnit = .inches
    let feeder = fu as? ICScannerFunctionalUnitDocumentFeeder
    let resolutions = Array(fu.supportedResolutions.isEmpty ? fu.preferredResolutions : fu.supportedResolutions)
    var colors = ["color", "gray"]
    if fu.supportedBitDepths.contains(1) { colors.append("bw") }
    return [
      "id": feeder != nil ? "feeder" : "flatbed",
      "duplex": feeder?.supportsDuplexScanning ?? false,
      "resolutions": resolutions,
      "colors": colors,
      "width": Double(fu.physicalSize.width),
      "height": Double(fu.physicalSize.height),
    ]
  }

  func configure(_ scanner: ICScannerDevice, _ fu: ICScannerFunctionalUnit) {
    fu.measurementUnit = .inches
    // The nearest resolution it offers
    let offered = Array(fu.supportedResolutions)
    if let best = offered.min(by: { abs($0 - options.dpi) < abs($1 - options.dpi) }) {
      fu.resolution = best
    }
    switch options.color {
    case "bw":
      fu.pixelDataType = .BW
      fu.bitDepth = .depth1Bit
    case "gray":
      fu.pixelDataType = .gray
      fu.bitDepth = .depth8Bits
    default:
      fu.pixelDataType = .RGB
      fu.bitDepth = .depth8Bits
    }
    let width = min(options.width, Double(fu.physicalSize.width))
    let height = min(options.height, Double(fu.physicalSize.height))
    if let feeder = fu as? ICScannerFunctionalUnitDocumentFeeder {
      feeder.documentType = documentType(width: options.width, height: options.height)
      if feeder.supportsDuplexScanning { feeder.duplexScanningEnabled = options.duplex }
    } else {
      fu.scanArea = NSRect(x: 0, y: 0, width: width, height: height)
    }
    scanner.transferMode = .fileBased
    scanner.downloadsDirectory = URL(fileURLWithPath: named["-outdir"] ?? NSTemporaryDirectory())
    scanner.documentName = "page"
    scanner.documentUTI = "public.png"
  }

  func scannerDevice(_ scanner: ICScannerDevice, didScanTo url: URL) {
    pages += 1
    emit(["type": "page", "file": url.path, "dpi": scanner.selectedFunctionalUnit.resolution])
  }

  func scannerDevice(_ scanner: ICScannerDevice, didCompleteScanWithError error: Error?) {
    if let error = error {
      let feederEmpty =
        (scanner.selectedFunctionalUnit as? ICScannerFunctionalUnitDocumentFeeder)?.documentLoaded == false
      if !(feederEmpty && pages > 0) {
        fail(feederEmpty ? "feeder-empty" : "failed", error.localizedDescription)
      }
    } else if pages == 0,
      let feeder = scanner.selectedFunctionalUnit as? ICScannerFunctionalUnitDocumentFeeder,
      !feeder.documentLoaded
    {
      fail("feeder-empty", "The document feeder is empty")
    }
    emit(["type": "done", "pages": pages])
    scanner.requestCloseSession()
    exit(0)
  }
}

let helper = Helper()
helper.start()
RunLoop.main.run()
