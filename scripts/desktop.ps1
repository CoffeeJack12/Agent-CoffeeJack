param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
$coffeeAction = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
switch ($coffeeAction.action) {
  'screenshot' {
    $coffeeBounds = [Windows.Forms.SystemInformation]::VirtualScreen
    $coffeeBitmap = New-Object Drawing.Bitmap $coffeeBounds.Width,$coffeeBounds.Height
    $coffeeGraphics = [Drawing.Graphics]::FromImage($coffeeBitmap)
    try { $coffeeGraphics.CopyFromScreen($coffeeBounds.Left,$coffeeBounds.Top,0,0,$coffeeBounds.Size); $coffeeBitmap.Save($coffeeAction.screenshot,[Drawing.Imaging.ImageFormat]::Png) }
    finally { $coffeeGraphics.Dispose(); $coffeeBitmap.Dispose() }
  }
  'click' {
    Add-Type 'using System; using System.Runtime.InteropServices; public static class CoffeeMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'
    [CoffeeMouse]::SetCursorPos([int]$coffeeAction.x,[int]$coffeeAction.y) | Out-Null
    [CoffeeMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    [CoffeeMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  }
  'type' {
    $coffeeEscaped = [regex]::Replace([string]$coffeeAction.text,'[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })
    [Windows.Forms.SendKeys]::SendWait($coffeeEscaped)
  }
  'key' { [Windows.Forms.SendKeys]::SendWait([string]$coffeeAction.text) }
  default { throw 'Unknown desktop action' }
}
