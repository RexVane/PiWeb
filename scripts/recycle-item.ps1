param([Parameter(Mandatory = $true)][string] $LiteralPath)
$ErrorActionPreference = 'Stop'

# Use IFileOperation's explicit recycle flag, not Remove-Item or a .NET deletion
# method that can fall back to permanent deletion. No recursive traversal here.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

public static class PiWebSystemTrash {
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint mode, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }
    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOperation {
        void Advise(IntPtr sink, out uint cookie);
        void Unadvise(uint cookie);
        void SetOperationFlags(uint flags);
        void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        void SetProgressDialog(IntPtr dialog);
        void SetProperties(IntPtr properties);
        void SetOwnerWindow(IntPtr owner);
        void ApplyPropertiesToItem(IShellItem item);
        void ApplyPropertiesToItems(IntPtr items);
        void RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        void RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
        void MoveItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        void MoveItems(IntPtr items, IShellItem destination);
        void CopyItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        void CopyItems(IntPtr items, IShellItem destination);
        void DeleteItem(IShellItem item, IntPtr sink);
        void DeleteItems(IntPtr items);
        void NewItem(IShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
        void PerformOperations();
        void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string name, IntPtr context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumeNameForVolumeMountPoint(string mountPoint, System.Text.StringBuilder volumeName, uint size);

    public static void Move(string source) {
        if (Environment.OSVersion.Version < new Version(6, 2)) throw new NotSupportedException("Explicit recycling requires Windows 8 or later.");
        string path = Path.GetFullPath(source);
        string root = Path.GetPathRoot(path);
        if (path.StartsWith(@"\\")) throw new NotSupportedException("Network paths have no local Recycle Bin.");
        DriveInfo drive = new DriveInfo(root);
        if (drive.DriveType != DriveType.Fixed && drive.DriveType != DriveType.Removable) throw new NotSupportedException("This volume has no supported Recycle Bin.");
        var name = new System.Text.StringBuilder(1024);
        if (!GetVolumeNameForVolumeMountPoint(root, name, (uint)name.Capacity)) throw new NotSupportedException("Cannot identify this volume's Recycle Bin.");
        string volume = name.ToString();
        int open = volume.IndexOf('{'), close = volume.IndexOf('}');
        if (open < 0 || close < open) throw new NotSupportedException("Cannot identify this volume's Recycle Bin.");
        using (RegistryKey settings = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\" + volume.Substring(open, close - open + 1))) {
            if (settings != null && Convert.ToInt32(settings.GetValue("NukeOnDelete", 0)) != 0) throw new NotSupportedException("The Recycle Bin is disabled for this volume.");
        }
        IShellItem item = null;
        IFileOperation operation = null;
        try {
            Guid iid = typeof(IShellItem).GUID;
            SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
            operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
            // FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE | FOFX_ADDUNDORECORD |
            // FOF_ALLOWUNDO | FOF_SILENT | FOF_NOERRORUI. Do not automatically
            // answer a permanent-deletion prompt with FOF_NOCONFIRMATION.
            operation.SetOperationFlags(0x00080000 | 0x00100000 | 0x20000000 | 0x0040 | 0x0004 | 0x0400);
            operation.DeleteItem(item, IntPtr.Zero);
            operation.PerformOperations();
            bool aborted;
            operation.GetAnyOperationsAborted(out aborted);
            if (aborted) throw new IOException("Recycling was cancelled; no permanent-delete fallback was attempted.");
        } finally {
            if (operation != null) Marshal.FinalReleaseComObject(operation);
            if (item != null) Marshal.FinalReleaseComObject(item);
        }
    }
}
'@
[PiWebSystemTrash]::Move($LiteralPath)
