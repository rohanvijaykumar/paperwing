// paperwing-scan: Paperwing's scanner helper for macOS (see desktop/scan.cjs
// and the build contract there). Apple's ImageCaptureCore, so USB and network
// (AirScan) scanners that work in Image Capture work here. One JSON object
// per line on stdout.
//
//   paperwing-scan list [-Wait <seconds>]
//   paperwing-scan caps -Id <id>
//   paperwing-scan preview -Id <id> -OutDir <folder> -Options <base64 JSON>
//   paperwing-scan scan -Id <id> -OutDir <folder> -Options <base64 JSON>
//
// While scanning, "cancel" on stdin stops after the current page and ends
// with {"type":"done","cancelled":true}. Built universal (Apple silicon and
// Intel) by build.sh.
import Foundation
import ImageCaptureCore
import ImageIO

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
    var line = String(data: data, encoding: .utf8)
  else { return }
  line += "\n"
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

/// What happened, for the logs (scan.cjs keeps the helper's stderr)
func debug(_ message: String) {
  FileHandle.standardError.write(("paperwing-scan: " + message + "\n").data(using: .utf8)!)
}

func fail(_ code: String, _ message: String) -> Never {
  debug("\(code): \(message)")
  emit(["type": "error", "code": code, "message": message])
  exit(2)
}

// Arguments: a command, then -Name value pairs (-DeviceId is the old -Id)
let argv = CommandLine.arguments
let command = argv.count > 1 ? argv[1] : ""
var named: [String: String] = [:]
var i = 2
while i + 1 < argv.count {
  named[argv[i].lowercased()] = argv[i + 1]
  i += 2
}
let deviceId = named["-id"] ?? named["-deviceid"]

struct Area { var x = 0.0, y = 0.0, width = 0.0, height = 0.0 }

struct ScanOptions {
  var source = "flatbed"
  var duplex = false
  var color = "color"
  var dpi = 300
  var area: Area?
  var paper: Area?  // width and height only
  var brightness: Double?
  var contrast: Double?
  var threshold: Double?
}

func readOptions() -> ScanOptions {
  var o = ScanOptions()
  guard let b64 = named["-options"], let data = Data(base64Encoded: b64),
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return o }
  func number(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
  func area(_ v: Any?) -> Area? {
    guard let d = v as? [String: Any], let w = number(d["width"]), let h = number(d["height"]),
      w > 0, h > 0
    else { return nil }
    return Area(x: number(d["x"]) ?? 0, y: number(d["y"]) ?? 0, width: w, height: h)
  }
  if let v = json["source"] as? String { o.source = v }
  if let v = json["duplex"] as? Bool { o.duplex = v }
  if let v = json["color"] as? String { o.color = v }
  if let v = number(json["dpi"]) { o.dpi = Int(v) }
  o.area = area(json["area"])
  o.paper = area(json["paper"])
  o.brightness = number(json["brightness"])
  o.contrast = number(json["contrast"])
  o.threshold = number(json["threshold"])
  return o
}

// Paper sizes in inches, by the scanner's document types
let paperTypes: [(ICScannerDocumentType, String, Double, Double)] = [
  (.typeUSLetter, "Letter", 8.5, 11),
  (.typeUSLegal, "Legal", 8.5, 14),
  (.typeUSLedger, "Tabloid", 11, 17),
  (.typeUSExecutive, "Executive", 7.25, 10.5),
  (.typeA3, "A3", 11.69, 16.54),
  (.typeA4, "A4", 8.27, 11.69),
  (.typeA5, "A5", 5.83, 8.27),
  (.typeA6, "A6", 4.13, 5.83),
  (.typeB5, "B5", 7.17, 10.12),
  (.typeBusinessCard, "Business card", 2.17, 3.58),
]

/// The feeder's paper for a size in inches (it scans whole sheets)
func documentType(_ fu: ICScannerFunctionalUnit, width: Double, height: Double)
  -> ICScannerDocumentType
{
  let supported = (fu as? ICScannerFunctionalUnitDocumentFeeder)?.supportedDocumentTypes
  let match = paperTypes.first { t in
    abs(t.2 - width) < 0.2 && abs(t.3 - height) < 0.2
      && (supported?.contains(Int(t.0.rawValue)) ?? true)
  }
  return match?.0 ?? .typeDefault
}

/// A brightness or contrast control among the driver's own settings
func vendorRange(_ fu: ICScannerFunctionalUnit, _ word: String) -> ICScannerFeatureRange? {
  for feature in fu.vendorFeatures ?? [] {
    guard let range = feature as? ICScannerFeatureRange else { continue }
    let names = "\(range.internalName ?? "") \(range.humanReadableName ?? "")".lowercased()
    if names.contains(word) { return range }
  }
  return nil
}

func rangeJSON(_ r: ICScannerFeatureRange?) -> Any {
  guard let r = r else { return NSNull() }
  return [
    "min": Double(r.minValue), "max": Double(r.maxValue),
    "step": r.stepSize > 0 ? Double(r.stepSize) : 1, "default": Double(r.defaultValue),
  ]
}

/// Where pages go (made if it isn't there yet)
func outDir() -> URL {
  let dir = URL(fileURLWithPath: named["-outdir"] ?? NSTemporaryDirectory())
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

/// Pixel size of an image file
func imageSize(_ url: URL) -> (Int, Int) {
  guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
    let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
  else { return (0, 0) }
  return (
    (props[kCGImagePropertyPixelWidth] as? Int) ?? 0,
    (props[kCGImagePropertyPixelHeight] as? Int) ?? 0
  )
}

// ImageCaptureCore's return codes (ICReturnCode in ICCommonConstants.h,
// which Swift doesn't import under that name)
let icTimedOut = -9923
let icInUseByLocalUser = -9925
let icInUseByRemoteUser = -9926

/// An ImageCaptureCore error as one of the contract's codes
func errorCode(_ error: Error, feeder: ICScannerFunctionalUnitDocumentFeeder?) -> String {
  let ns = error as NSError
  switch ns.code {
  case icInUseByLocalUser, icInUseByRemoteUser: return "busy"
  case icTimedOut: return "offline"
  default: break
  }
  // Drivers say what happened in words; these are the ones worth telling apart
  let text = ns.localizedDescription.lowercased()
  if text.contains("jam") { return "paper-jam" }
  if text.contains("cover") || text.contains("door") || text.contains("lid") { return "cover-open" }
  if text.contains("double") || text.contains("multi") { return "double-feed" }
  if feeder?.documentLoaded == false || text.contains("no paper") || text.contains("no document") {
    return feeder != nil ? "feeder-empty" : "failed"
  }
  if text.contains("busy") || text.contains("in use") { return "busy" }
  return "failed"
}

final class Helper: NSObject, ICDeviceBrowserDelegate, ICScannerDeviceDelegate {
  let browser = ICDeviceBrowser()
  var found: [ICScannerDevice] = []
  var target: ICScannerDevice?
  var pendingUnits: [ICScannerFunctionalUnitType] = []
  var sources: [[String: Any]] = []
  var options = ScanOptions()
  var pages = 0
  var cancelled = false
  var finishing = false
  /// Set once the last line is out: exit when the session has closed
  var closeExitCode: Int32?

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
      let wait = Double(named["-wait"] ?? "") ?? 4
      DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
        emit(["type": "scanners", "scanners": self.found.map(self.describeDevice)])
        exit(0)
      }
    case "caps", "scan", "preview":
      if command != "caps" {
        options = readOptions()
        listenForCancel()
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
        if self.target == nil { fail("no-scanner", "Scanner not found") }
      }
      watch()
    default:
      fail("failed", "Unknown command: \(command)")
    }
  }

  /// A scanner that stops answering mustn't leave this waiting forever:
  /// a minute for its settings, three minutes for each page
  var watchdog: DispatchWorkItem?
  func watch() {
    watchdog?.cancel()
    let item = DispatchWorkItem {
      self.finish(
        ["type": "error", "code": "failed", "message": "The scanner stopped responding"], code: 2)
    }
    watchdog = item
    DispatchQueue.main.asyncAfter(deadline: .now() + (pages == 0 && command == "caps" ? 60 : 180), execute: item)
  }

  /// "cancel" on stdin. End of input (no parent listening) changes nothing.
  func listenForCancel() {
    Thread.detachNewThread {
      while let line = readLine() {
        if line.trimmingCharacters(in: .whitespaces) == "cancel" {
          DispatchQueue.main.async { self.cancel() }
        }
      }
    }
  }

  func cancel() {
    guard !cancelled, !finishing else { return }
    cancelled = true
    guard let scanner = target else {
      emit(["type": "done", "pages": pages, "cancelled": true])
      exit(0)
    }
    scanner.cancelScan()
    // Normally the scan completes (cancelled) at once; never wait long
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
      self.finish(["type": "done", "pages": self.pages, "cancelled": true])
    }
  }

  /// The last line, then the scanner is released before exiting
  func finish(_ event: [String: Any], code: Int32 = 0) {
    guard !finishing else { return }
    finishing = true
    emit(event)
    guard let scanner = target, scanner.hasOpenSession else { exit(code) }
    closeExitCode = code
    scanner.requestCloseSession()
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(code) }
  }

  func describeDevice(_ d: ICScannerDevice) -> [String: Any] {
    let name = d.name ?? "Scanner"
    // The transport's name is a string constant such as ICTransportTypeUSB
    let transport = String(describing: d.transportType)
    let words = name.split(separator: " ", maxSplits: 1).map(String.init)
    return [
      "id": d.uuidString ?? name,
      "name": name,
      "driver": "ica",
      "deviceKey": (d.uuidString ?? name).lowercased(),
      "make": words.count > 1 ? words[0] : "",
      "model": words.count > 1 ? words[1] : name,
      "connection": transport.contains("USB")
        ? "usb" : transport.contains("TCPIP") || transport.contains("Bonjour") ? "network" : "unknown",
    ]
  }

  // MARK: Finding the scanner

  func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
    guard let scanner = device as? ICScannerDevice else { return }
    found.append(scanner)
    guard command != "list", target == nil, let id = deviceId,
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
    if let error = error {
      let code = (error as NSError).code
      fail(code == icTimedOut ? "offline" : "busy", error.localizedDescription)
    }
    debug("session open; units \(target?.availableFunctionalUnitTypes ?? [])")
    // A scanner describes its parts once it's ready (network scanners take a
    // moment); some never say so, hence the fallback
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.begin() }
  }

  func deviceDidBecomeReady(_ device: ICDevice) {
    debug("ready")
    begin()
  }

  var begun = false
  var requested: ICScannerFunctionalUnitType?

  func select(_ type: ICScannerFunctionalUnitType) {
    requested = type
    debug("selecting \(type.rawValue)")
    target?.requestSelect(type)
  }

  func begin() {
    guard !begun, let scanner = target, scanner.hasOpenSession else { return }
    begun = true
    if cancelled { return finish(["type": "done", "pages": 0, "cancelled": true]) }
    let types = scanner.availableFunctionalUnitTypes.compactMap {
      ICScannerFunctionalUnitType(rawValue: $0.uintValue)
    }
    debug("units \(types.map { $0.rawValue }), selected \(scanner.selectedFunctionalUnit.type.rawValue)")
    switch command {
    case "caps":
      pendingUnits = types.filter { $0 == .flatbed || $0 == .documentFeeder }
      if pendingUnits.isEmpty { pendingUnits = [scanner.selectedFunctionalUnit.type] }
      select(pendingUnits.removeFirst())
    case "preview":
      if !types.contains(.flatbed) && !types.isEmpty {
        fail("unsupported", "This scanner has no flatbed to preview")
      }
      select(.flatbed)
    default:
      let want: ICScannerFunctionalUnitType =
        options.source == "feeder" ? .documentFeeder : .flatbed
      if !types.contains(want) && !(types.isEmpty && want == .flatbed) {
        fail("unsupported",
          "This scanner has no \(options.source == "feeder" ? "document feeder" : "flatbed")")
      }
      select(want)
    }
  }

  func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {
    if let code = closeExitCode { exit(code) }
  }

  // MARK: What it can do, and scanning

  func scannerDevice(
    _ scanner: ICScannerDevice, didSelect functionalUnit: ICScannerFunctionalUnit, error: Error?
  ) {
    debug("selected \(functionalUnit.type.rawValue) \(error.map { "\($0)" } ?? "")")
    // The scanner picking its own unit as the session opens isn't our answer
    guard let want = requested, functionalUnit.type == want || error != nil else { return }
    if let error = error { fail("busy", error.localizedDescription) }
    // Network scanners report the unit first and its details (sizes,
    // resolutions) in a second call; wait a little for that
    let described = !functionalUnit.supportedResolutions.isEmpty || functionalUnit.physicalSize.width > 0
    if !described && !waitedForDetails {
      waitedForDetails = true
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
        if self.requested == want { self.selected(scanner, scanner.selectedFunctionalUnit) }
      }
      return
    }
    selected(scanner, functionalUnit)
  }

  var waitedForDetails = false

  /// The unit asked for is selected and described: carry on with the command
  func selected(_ scanner: ICScannerDevice, _ functionalUnit: ICScannerFunctionalUnit) {
    requested = nil
    waitedForDetails = false
    if cancelled { return finish(["type": "done", "pages": 0, "cancelled": true]) }
    switch command {
    case "caps":
      sources.append(describe(functionalUnit))
      if pendingUnits.isEmpty {
        finish(["type": "caps", "driver": "ica", "nativeUi": false, "sources": sources])
        return
      }
      select(pendingUnits.removeFirst())
    case "preview":
      guard functionalUnit.canPerformOverviewScan else {
        fail("unsupported", "This scanner can't make a preview")
      }
      functionalUnit.measurementUnit = .inches
      functionalUnit.pixelDataType = .RGB
      functionalUnit.bitDepth = .depth8Bits
      scanner.requestOverviewScan()
    default:
      configure(scanner, functionalUnit)
      scanner.requestScan()
    }
  }

  func describe(_ fu: ICScannerFunctionalUnit) -> [String: Any] {
    fu.measurementUnit = .inches
    let feeder = fu as? ICScannerFunctionalUnitDocumentFeeder
    let resolutions = Array(
      fu.supportedResolutions.isEmpty ? fu.preferredResolutions : fu.supportedResolutions)
    var colors = ["color", "gray"]
    let bw = fu.supportedBitDepths.contains(1)
    if bw { colors.append("bw") }
    let width = Double(fu.physicalSize.width)
    let height = Double(fu.physicalSize.height)
    let types: IndexSet? =
      feeder?.supportedDocumentTypes ?? (fu as? ICScannerFunctionalUnitFlatbed)?.supportedDocumentTypes
    let sizes = paperTypes.filter { t in
      if let types = types, !types.isEmpty { return types.contains(Int(t.0.rawValue)) }
      return t.2 <= width + 0.05 && t.3 <= height + 0.05
    }
    let threshold: Any =
      bw && fu.acceptsThresholdForBlackAndWhiteScanning
      ? [
        "min": 0, "max": 255, "step": 1,
        "default": Int(fu.defaultThresholdForBlackAndWhiteScanning),
      ] : NSNull()
    return [
      "id": feeder != nil ? "feeder" : "flatbed",
      "duplex": feeder?.supportsDuplexScanning ?? false,
      "resolutions": resolutions,
      "colors": colors,
      "maxWidth": width,
      "maxHeight": height,
      "minWidth": 0,
      "minHeight": 0,
      "canPreview": feeder == nil && fu.canPerformOverviewScan,
      "paperSizes": sizes.map { ["name": $0.1, "width": $0.2, "height": $0.3] },
      "autoSize": false,
      "autoDeskew": false,
      "autoCrop": false,
      "blankPageSkip": false,
      "doubleFeed": false,
      "invert": false,
      "brightness": rangeJSON(vendorRange(fu, "brightness")),
      "contrast": rangeJSON(vendorRange(fu, "contrast")),
      "threshold": threshold,
      "feederLoaded": feeder.map { $0.documentLoaded as Any } ?? NSNull(),
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
      if let t = options.threshold, fu.acceptsThresholdForBlackAndWhiteScanning {
        fu.usesThresholdForBlackAndWhiteScanning = true
        fu.thresholdForBlackAndWhiteScanning = UInt8(max(0, min(255, t.rounded())))
      }
    case "gray":
      fu.pixelDataType = .gray
      fu.bitDepth = .depth8Bits
    default:
      fu.pixelDataType = .RGB
      fu.bitDepth = .depth8Bits
    }
    for (word, value) in [("brightness", options.brightness), ("contrast", options.contrast)] {
      if let v = value, let r = vendorRange(fu, word) {
        r.currentValue = CGFloat(max(Double(r.minValue), min(Double(r.maxValue), v)))
      }
    }
    let full = (Double(fu.physicalSize.width), Double(fu.physicalSize.height))
    if let feeder = fu as? ICScannerFunctionalUnitDocumentFeeder {
      if let paper = options.paper ?? options.area {
        feeder.documentType = documentType(fu, width: paper.width, height: paper.height)
      }
      if feeder.supportsDuplexScanning { feeder.duplexScanningEnabled = options.duplex }
    } else {
      // An area, a paper size from the top left corner, or the whole glass
      let a = options.area ?? options.paper ?? Area(width: full.0, height: full.1)
      let w = min(a.width, full.0)
      let h = min(a.height, full.1)
      fu.scanArea = NSRect(
        x: max(0, min(a.x, full.0 - w)), y: max(0, min(a.y, full.1 - h)), width: w, height: h)
    }
    scanner.transferMode = .fileBased
    scanner.downloadsDirectory = outDir()
    scanner.documentName = "page"
    scanner.documentUTI = "public.png"
  }

  func scannerDevice(_ scanner: ICScannerDevice, didScanTo url: URL) {
    let duplex = (scanner.selectedFunctionalUnit as? ICScannerFunctionalUnitDocumentFeeder)?
      .duplexScanningEnabled ?? false
    let (w, h) = imageSize(url)
    emit([
      "type": "page", "file": url.path, "dpi": scanner.selectedFunctionalUnit.resolution,
      "width": w, "height": h,
      // Two-sided feeders deliver each sheet's front, then its back
      "side": duplex && pages % 2 == 1 ? "back" : "front",
    ])
    pages += 1
    watch()
  }

  func scannerDevice(_ scanner: ICScannerDevice, didCompleteOverviewScanWithError error: Error?) {
    if cancelled { return finish(["type": "done", "pages": 0, "cancelled": true]) }
    if let error = error {
      return finish(
        ["type": "error", "code": errorCode(error, feeder: nil),
         "message": error.localizedDescription], code: 2)
    }
    let fu = scanner.selectedFunctionalUnit
    guard let image = fu.overviewImage else {
      return finish(
        ["type": "error", "code": "failed", "message": "The scanner sent no preview"], code: 2)
    }
    let dir = outDir()
    let url = dir.appendingPathComponent("preview.png")
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
    else {
      return finish(
        ["type": "error", "code": "failed", "message": "The preview couldn't be saved"], code: 2)
    }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else {
      return finish(
        ["type": "error", "code": "failed", "message": "The preview couldn't be saved"], code: 2)
    }
    emit([
      "type": "page", "file": url.path, "dpi": fu.overviewResolution,
      "width": image.width, "height": image.height, "side": "front",
    ])
    finish(["type": "done", "pages": 1])
  }

  func scannerDevice(_ scanner: ICScannerDevice, didCompleteScanWithError error: Error?) {
    if cancelled { return finish(["type": "done", "pages": pages, "cancelled": true]) }
    let feeder = scanner.selectedFunctionalUnit as? ICScannerFunctionalUnitDocumentFeeder
    if let error = error {
      let code = errorCode(error, feeder: feeder)
      // The feeder running out after some pages is how a feeder scan ends
      if !(code == "feeder-empty" && pages > 0) {
        return finish(
          ["type": "error", "code": code, "message": error.localizedDescription], code: 2)
      }
    } else if pages == 0, let feeder = feeder, !feeder.documentLoaded {
      return finish(
        ["type": "error", "code": "feeder-empty", "message": "The document feeder is empty"],
        code: 2)
    }
    finish(["type": "done", "pages": pages])
  }
}

let helper = Helper()
helper.start()
RunLoop.main.run()
