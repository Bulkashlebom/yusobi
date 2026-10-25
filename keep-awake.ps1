param([int]$OwnerProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YsobiPower {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
try {
    if ([YsobiPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }
    while (Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue) {
        Start-Sleep -Seconds 10
    }
} finally {
    [void][YsobiPower]::SetThreadExecutionState([uint32]2147483648)
}
