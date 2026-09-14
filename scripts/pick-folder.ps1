# Pop the Windows modern folder picker (IFileOpenDialog, Explorer style, centered).
# Usage: powershell -NoProfile -STA -ExecutionPolicy Bypass -File pick-folder.ps1 [title]
# Output: the selected path on one line; empty when canceled.
#
# Encoding contract: this file must stay pure ASCII. Windows PowerShell 5.1 reads
# BOM-less .ps1 files with the active ANSI code page (GBK on zh-CN), so any literal
# CJK character here would reach the dialog mojibake'd. Non-ASCII UI strings are
# embedded as C# \uXXXX escapes instead.
param([string]$Title = 'Select workspace folder')

# PowerShell 5.1 otherwise emits text using the active Windows code page.
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

$src = @'
using System;
using System.Runtime.InteropServices;

public class PiFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialogRCW {}

  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    [PreserveSig] int SetFileTypeIndex(uint iFileType);
    [PreserveSig] int GetFileTypeIndex(out uint piFileType);
    [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
    [PreserveSig] int Unadvise(uint pdwCookie);
    [PreserveSig] int SetOptions(uint fos);
    [PreserveSig] int GetOptions(out uint pfos);
    [PreserveSig] int SetDefaultFolder(IShellItem psi);
    [PreserveSig] int SetFolder(IShellItem psi);
    [PreserveSig] int GetFolder(out IShellItem ppsi);
    [PreserveSig] int GetCurrentSelection(out IShellItem ppsi);
    [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    [PreserveSig] int GetResult(out IShellItem ppsi);
    [PreserveSig] int AddPlace(IShellItem psi, int fdap);
    [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    [PreserveSig] int Close(int hr);
    [PreserveSig] int SetClientGuid(ref Guid guid);
    [PreserveSig] int ClearClientData();
    [PreserveSig] int SetFilter(IntPtr pFilter);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetParent(out IShellItem ppsi);
    [PreserveSig] int GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
  }

  private const uint FOS_PICKFOLDERS = 0x20;
  private const uint FOS_FORCEFILESYSTEM = 0x40;
  private const uint SIGDN_FILESYSPATH = 0x80058000;

  // Ok-button label ("select this folder", zh) as escapes: keep this .ps1 ASCII.
  private const string OkLabel = "\u9009\u62E9\u6B64\u6587\u4EF6\u5939";

  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

  // A non-DPI-aware host process gets the dialog bitmap-stretched on scaled
  // displays (blurry). Per-Monitor V2 (-4) keeps it crisp; fall back to the
  // legacy declaration on pre-1703 Windows. Best effort: both may no-op when
  // awareness is already set by a manifest.
  private static void EnableDpiAwareness() {
    try {
      if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
    } catch {
      try { SetProcessDPIAware(); } catch {}
    }
  }

  public static string Pick(string title) {
    try {
      EnableDpiAwareness();
      var dlg = (IFileDialog)(new FileOpenDialogRCW());
      uint options;
      dlg.GetOptions(out options);
      dlg.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
      if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
      dlg.SetOkButtonLabel(OkLabel);
      int hr = dlg.Show(GetForegroundWindow());
      if (hr != 0) return "";
      IShellItem item;
      dlg.GetResult(out item);
      string path;
      item.GetDisplayName(SIGDN_FILESYSPATH, out path);
      return path ?? "";
    } catch {
      return "";
    }
  }
}
'@

Add-Type -TypeDefinition $src -Language CSharp
$result = [PiFolderPicker]::Pick($Title)
Write-Output $result
