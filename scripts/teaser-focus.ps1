# Keep the dcs-studio IDE sized to 1920x1080 at the top-left (0,0) and in front
# during a teaser take, and keep the DCS window minimized — so the recorder can
# capture exactly that 1920x1080 region and DCS (launched windowed mid-take)
# never covers the IDE. The recorder runs this in the background while the
# speedrun drives the app.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
# Use PHYSICAL pixels for MoveWindow so 1920x1080 matches the gdigrab capture
# region exactly on a high-DPI display (otherwise the coords are DPI-virtualised
# and the window ends up ~2880x1620, cropping the capture).
[W]::SetProcessDPIAware() | Out-Null
$SW_RESTORE = 9
$SW_MINIMIZE = 6
while ($true) {
  foreach ($p in Get-Process -Name 'dcs-studio' -ErrorAction SilentlyContinue) {
    $h = $p.MainWindowHandle
    if ($h -ne 0) {
      if ([W]::IsZoomed($h)) { [W]::ShowWindow($h, $SW_RESTORE) | Out-Null }  # un-maximize
      [W]::MoveWindow($h, 0, 0, 1920, 1080, $true) | Out-Null
      [W]::BringWindowToTop($h) | Out-Null
      [W]::SetForegroundWindow($h) | Out-Null
    }
  }
  foreach ($d in Get-Process -Name 'DCS' -ErrorAction SilentlyContinue) {
    if ($d.MainWindowHandle -ne 0) { [W]::ShowWindow($d.MainWindowHandle, $SW_MINIMIZE) | Out-Null }
  }
  Start-Sleep -Milliseconds 600
}
