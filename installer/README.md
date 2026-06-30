# Installer — English Oral Teacher

## Prerequisites

- Windows 10+ x64
- [Inno Setup 6](https://jrsoftware.org/isinfo.php) (for building the installer)
- pnpm + Node 22 (for building the .exe)

## Icon files

Place in `installer/icons/`:

- `app.ico` — 256x256 multi-resolution app icon (16, 32, 48, 64, 128, 256)
- `installer-banner.bmp` — 164x314 px, Inno Setup wizard banner
- `installer-sidebar.bmp` — 55x55 px, Inno Setup sidebar

Use a free icon from [icon-icons.com](https://icon-icons.com) or create custom.

## Build

```bash
# 1. Build the .exe (requires pnpm + Node 22)
bash scripts/build-installer.sh 1.0.6

# 2. Build the Inno Setup installer
# Open installer/installer.iss in Inno Setup Compiler and compile,
# or run from command line:
iscc installer/installer.iss
```

Output:
- `installer/build/EnglishOralTeacher.exe` (~25MB, standalone server .exe)
- `installer/build/EnglishOralTeacher-Setup-v1.0.6.exe` (~30MB, installer)

## Install / Uninstall

- Install: double-click the Setup .exe, follow the wizard
- Uninstall: Windows Settings → Apps → English Oral Teacher, or Start Menu → Uninstall
- Upgrade: run the new Setup .exe; the installer detects and upgrades the existing installation
- Data: by default, conversation history in `%APPDATA%\EnglishOralTeacher\` is preserved during uninstall

## Version bump checklist

1. Update `installer/installer.iss`: change `{#MyAppVersion}` defines
2. Update `package.json`: version field
3. Run `bash scripts/build-installer.sh <new-version>`
4. Run `iscc installer/installer.iss`
5. Upload both .exe files to GitHub Releases

## Known limitations

- Windows x64 only (no x86 / ARM64 support)
- Unsigned .exe — SmartScreen will show a warning on first run. Click "More info" → "Run anyway"
- No system tray (console window stays open)
- Port 8787 must be free (change PORT in AppData/.env if needed)
