# Writes config/arp-cache.txt from the Windows neighbor table so the
# collector, inside Docker, can map a device MAC to its current IP.
# If a configured MAC is missing, pings the local /24 once a minute to fill the table.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$devicesPath = Join-Path $root "config\devices.yml"
$outPath = Join-Path $root "config\arp-cache.txt"

function Convert-Mac([string]$raw) {
    $hex = ($raw -replace '[^0-9a-fA-F]', '').ToLower()
    if ($hex.Length -ne 12) { return $null }
    return ((0..5 | ForEach-Object { $hex.Substring($_ * 2, 2) }) -join ':')
}

function Get-DeviceMacs {
    if (-not (Test-Path $devicesPath)) { return @() }
    $macs = @()
    foreach ($line in Get-Content $devicesPath) {
        if ($line -match 'mac:\s*(\S+)') {
            $mac = Convert-Mac $Matches[1]
            if ($mac) { $macs += $mac }
        }
    }
    return $macs
}

function Get-LanNeighbors {
    Get-NetNeighbor -AddressFamily IPv4 | Where-Object {
        $_.IPAddress -match '^\d+\.\d+\.\d+\.\d+$' -and
        $_.IPAddress -notlike '224.*' -and
        $_.IPAddress -notlike '239.*' -and
        $_.IPAddress -notlike '255.*' -and
        $_.State -ne 'Incomplete' -and
        $_.LinkLayerAddress
    }
}

function Export-Cache {
    $rank = @{
        Reachable = 0
        Permanent = 1
        Probe = 2
        Delay = 3
        Stale = 4
        Unreachable = 5
    }
    $best = @{}
    foreach ($neighbor in Get-LanNeighbors) {
        $mac = Convert-Mac $neighbor.LinkLayerAddress
        if (-not $mac -or $mac -eq "00:00:00:00:00:00" -or $mac -eq "ff:ff:ff:ff:ff:ff" -or $mac.StartsWith("01:00:5e")) { continue }
        $score = 9
        if ($rank.ContainsKey([string]$neighbor.State)) { $score = $rank[[string]$neighbor.State] }
        if ($best.ContainsKey($mac) -and $best[$mac].Score -le $score) { continue }
        $best[$mac] = @{ Score = $score; IP = $neighbor.IPAddress }
    }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($mac in $best.Keys) {
        $lines.Add("$mac $($best[$mac].IP)")
    }
    $tmp = "$outPath.tmp"
    [System.IO.File]::WriteAllText($tmp, (($lines -join "`n") + "`n"))
    Move-Item -Force $tmp $outPath
    return @($best.Keys)
}

function Get-SweepBases {
    $bases = @{}
    Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object {
        if ($_.InterfaceAlias -match 'vEthernet|WSL|Docker|Loopback|Bluetooth|Hyper-V|Default Switch') { return }
        if ($_.IPAddress -match '^(192\.168\.\d+)\.\d+$') { $bases[$Matches[1]] = $true }
    }
    return @($bases.Keys)
}

function Invoke-Sweep {
    foreach ($base in Get-SweepBases) {
        $pings = @()
        foreach ($i in 1..254) {
            $ping = New-Object System.Net.NetworkInformation.Ping
            [void]$ping.SendPingAsync("$base.$i", 200)
            $pings += $ping
        }
        Start-Sleep -Seconds 3
        foreach ($ping in $pings) { $ping.Dispose() }
    }
}

$lastSweep = [datetime]::MinValue
while ($true) {
    try {
        $known = Export-Cache
        $missing = @(Get-DeviceMacs | Where-Object { $known -notcontains $_ })
        if ($missing.Count -gt 0 -and ((Get-Date) - $lastSweep).TotalSeconds -gt 60) {
            Invoke-Sweep
            $lastSweep = Get-Date
            Export-Cache | Out-Null
        }
    } catch {
        Write-Host "[arp] $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 10
}
