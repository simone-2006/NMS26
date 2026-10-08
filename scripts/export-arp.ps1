# Writes config/arp-cache.txt from the Windows neighbor table so the
# collector, inside Docker, can map a device MAC to its current IP.
# Every 45s it also asks the LAN for the names devices announce
# (mDNS and NetBIOS) and appends them: "mac ip name".
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

$script:LanNames = @{}
$script:NextNames = [datetime]::MinValue

function Update-LanNames {
    if ((Get-Date) -lt $script:NextNames) { return }
    $script:NextNames = (Get-Date).AddSeconds(45)
    $resolver = Join-Path $PSScriptRoot "lan-names.py"
    if (-not (Test-Path $resolver)) { return }
    $python = $null
    foreach ($cmd in @("python", "py")) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) { $python = $cmd; break }
    }
    if (-not $python) { return }
    try {
        & $python $resolver
        $path = Join-Path $root "config\lan-names.txt"
        if (-not (Test-Path $path)) { return }
        $fresh = @{}
        foreach ($line in [System.IO.File]::ReadAllLines($path, [System.Text.UTF8Encoding]::new($false))) {
            $parts = $line.Split("`t", 2)
            if ($parts.Length -eq 2 -and $parts[0] -and $parts[1].Trim()) {
                $fresh[$parts[0].Trim()] = $parts[1].Trim()
            }
        }
        if ($fresh.Count -gt 0) { $script:LanNames = $fresh }
    } catch {
        Write-Host "[arp] names $($_.Exception.Message)"
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
        $ip = $best[$mac].IP
        $name = $script:LanNames[$ip]
        if ($name) { $lines.Add("$mac $ip $name") } else { $lines.Add("$mac $ip") }
    }
    $tmp = "$outPath.tmp"
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($tmp, (($lines -join "`n") + "`n"), $utf8)
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
        Update-LanNames
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
