# Installing Paperwing

Download the file for your computer from the
**[latest release](https://github.com/rohanvijaykumar/paperwing/releases/latest)**.

- [Windows](#windows)
- [macOS](#macos)
- [Updating](#updating)
- [Uninstalling](#uninstalling)

---

## Windows

Windows 10 or 11, 64-bit. There are two versions with the same features: an installer, and a
portable version that runs without installing.

### Installer (recommended)

1. Download `Paperwing-Setup-<version>-x64.exe` and run it.
2. If **Windows protected your PC** appears, click **More info ▸ Run anyway**. (Paperwing isn't
   code-signed yet; the warning appears for any unsigned app.)
3. Choose where to install and finish the setup.

The installer adds Start-menu and desktop shortcuts and offers Paperwing as an app for opening PDFs.
To make it your default PDF app: **Settings ▸ Apps ▸ Default apps**, search for `.pdf` and choose Paperwing.

### Portable (.zip)

`Paperwing-Portable-<version>-win-x64.zip` runs without installing anything — handy on a USB stick or
a computer where you can't install software.

1. Unzip it anywhere (right-click ▸ **Extract All…**).
2. Run `Paperwing.exe` inside the folder.

Settings, recent files and downloaded engines are kept in a **Paperwing Data** folder inside it, so
the whole folder can move between computers. (If the folder isn't writable, for example under
`C:\Program Files`, Paperwing uses your user profile instead.)

### First Office conversion

To keep the download small, the LibreOffice engine used by **Word / Excel / PowerPoint → PDF** isn't
included. The first time you use one of those tools, Paperwing downloads it (about 75 MB) and keeps
it for next time, so you need an internet connection once. Everything else works offline from the
start.

---

## macOS

macOS 12 Monterey or later.

| Your Mac                        | Download                            |
| ------------------------------- | ----------------------------------- |
| Apple Silicon (M1, M2, M3, M4…) | `Paperwing-<version>-mac-arm64.dmg` |
| Intel                           | `Paperwing-<version>-mac-x64.dmg`   |

Not sure? Apple menu ▸ **About This Mac** — "Chip: Apple…" means Apple Silicon.

1. Open the `.dmg` and drag **Paperwing** into **Applications**.
2. The first time, **right-click (or Control-click) Paperwing in Applications and choose Open**, then
   click **Open** in the dialog. You only need to do this once.

If macOS says the app **"is damaged and can't be opened"**, that is Gatekeeper's message for
downloaded apps that aren't notarised by Apple. Run this once in Terminal and open it again:

```bash
xattr -cr /Applications/Paperwing.app
```

To open PDFs with Paperwing by default: select any PDF in Finder ▸ **File ▸ Get Info** ▸
**Open with: Paperwing** ▸ **Change All…**

---

## Updating

Paperwing checks this project's GitHub Releases once a day (you can turn this off in
**Menu ▸ Preferences**, and check any time from **Help ▸ Check for updates**).

- **Windows installer (1.1 and later):** a new version downloads in the background. When it's ready,
  Paperwing offers **Restart now** or **Later**; if you choose Later, it installs the next time you
  quit. Your settings, recent files and pinned tools are kept.
- **Windows portable and macOS:** Paperwing shows a notice with a link to the new version. Install it
  over the old one (macOS), or unzip it and copy your **Paperwing Data** folder into it (portable).
- **Coming from 1.0.x:** install 1.1 once by hand; updates are automatic from then on.

## Uninstalling

- **Windows installer:** Settings ▸ Apps ▸ Installed apps ▸ Paperwing ▸ Uninstall.
- **Windows portable:** delete the folder.
- **macOS:** drag Paperwing from Applications to the Bin. Settings live in
  `~/Library/Application Support/Paperwing` if you want to remove them too.
