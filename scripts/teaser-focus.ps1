# Keep the dcs-studio IDE maximized + in front during a teaser take, and keep the
# DCS window minimized, so DCS (launched mid-take, windowed) never covers the IDE.
# The recorder runs this in the background while the speedrun drives the app.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
"@
$SW_MAXIMIZE = 3
$SW_MINIMIZE = 6
while ($true) {
  foreach ($p in Get-Process -Name 'dcs-studio' -ErrorAction SilentlyContinue) {
    if ($p.MainWindowHandle -ne 0) {
      [W]::ShowWindow($p.MainWindowHandle, $SW_MAXIMIZE) | Out-Null
      [W]::BringWindowToTop($p.MainWindowHandle) | Out-Null
      [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    }
  }
  foreach ($d in Get-Process -Name 'DCS' -ErrorAction SilentlyContinue) {
    if ($d.MainWindowHandle -ne 0) { [W]::ShowWindow($d.MainWindowHandle, $SW_MINIMIZE) | Out-Null }
  }
  Start-Sleep -Milliseconds 600
}
