#define MyAppVersion "1.0.6"

[Setup]
AppName=English Oral Teacher
AppVersion={#MyAppVersion}
AppPublisher=zhiyicom
DefaultDirName={autopf}\EnglishOralTeacher
DisableProgramGroupPage=yes
DisableDirPage=no
OutputDir=build
OutputBaseFilename=EnglishOralTeacher-Setup-v{#MyAppVersion}
; SetupIconFile=installer\icons\app.ico  ; placeholder: add icon to installer/icons/
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=120
UninstallDisplayIcon={app}\EnglishOralTeacher.exe
UninstallDisplayName=English Oral Teacher
VersionInfoVersion={#MyAppVersion}

[Files]
; Source paths are relative to this .iss file (installer/ directory)
Source: "build\EnglishOralTeacher.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\English Oral Teacher"; Filename: "{app}\EnglishOralTeacher.exe"; IconFilename: "{app}\EnglishOralTeacher.exe"; Tasks: desktopicon
Name: "{autostartmenu}\English Oral Teacher"; Filename: "{app}\EnglishOralTeacher.exe"; Tasks: startmenu
Name: "{autostartmenu}\Uninstall English Oral Teacher"; Filename: "{uninstallexe}"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce
Name: "startmenu"; Description: "Create a Start Menu shortcut"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Run]
Filename: "{app}\EnglishOralTeacher.exe"; Description: "Run English Oral Teacher"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"

[Code]
function ShouldDeleteAppData(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if MsgBox(
    'Delete conversation history, settings, and student profile?' + #13#10 +
    '(Select "No" to keep them for future use)',
    mbConfirmation, MB_YESNO
  ) = IDYES then
    Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    if ShouldDeleteAppData() then begin
      DelTree(ExpandConstant('{userappdata}\EnglishOralTeacher'), True, True, True);
    end;
  end;
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if RegKeyExists(HKLM, 'SOFTWARE\EnglishOralTeacher') then begin
    if MsgBox(
      'An existing installation was detected. Upgrade?' + #13#10 +
      '(Upgrading will keep your conversation history and settings)',
      mbConfirmation, MB_YESNO
    ) = IDNO then begin
      Result := False;
    end;
  end;
end;
