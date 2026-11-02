<#
.SYNOPSIS
    Installs an existing, hash-locked official KimiCU payload outside the repository.
.DESCRIPTION
    This installer never downloads payloads. It requires a complete local source and
    a payload lock containing every file's exact size and SHA-256. No administrator
    rights are required. Use -Doctor, -Rollback, -Uninstall, or -DryRun as needed.
#>
[CmdletBinding(DefaultParameterSetName = "Install")]
param(
    [Parameter(ParameterSetName = "Install", Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(ParameterSetName = "Install")]
    [string]$LockPath,

    [Parameter(ParameterSetName = "Rollback", Mandatory = $true)]
    [switch]$Rollback,

    [Parameter(ParameterSetName = "Doctor", Mandatory = $true)]
    [switch]$Doctor,

    [Parameter(ParameterSetName = "Uninstall", Mandatory = $true)]
    [switch]$Uninstall,

    [Parameter(ParameterSetName = "Install")]
    [Parameter(ParameterSetName = "Rollback")]
    [Parameter(ParameterSetName = "Uninstall")]
    [switch]$DryRun,

    [string]$InstallRoot = $(if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA "KimiCU-Community"
    } else { $null })
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
if (-not $InstallRoot) {
    throw "LOCALAPPDATA is unavailable; pass -InstallRoot explicitly."
}
if ($PSCmdlet.ParameterSetName -eq "Install" -and -not $LockPath) {
    $LockPath = Join-Path $repoRoot "payload-lock.json"
}

function Get-AbsolutePath([string]$Value) {
    $fullPath = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Value))
    if ($fullPath.StartsWith('\\?\')) { $fullPath = $fullPath.Substring(4) }
    return $fullPath
}

function Get-CanonicalPath([string]$PathValue) {
    $parent = Split-Path -Parent $PathValue
    $leaf = Split-Path -Leaf $PathValue
    if (-not $parent -or -not $leaf) { return $PathValue }
    $match = Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ieq $leaf } |
        Select-Object -First 1
    if ($match) { return $match.FullName }
    return $PathValue
}

function Get-RelativePayloadPath([string]$BasePath, [string]$FullPath) {
    $relative = $FullPath.Substring($BasePath.TrimEnd('\').Length).TrimStart('\')
    return $relative.Replace('\', '/')
}

function Test-PathInside([string]$Candidate, [string]$Directory) {
    $candidateFull = Get-AbsolutePath $Candidate
    $directoryFull = (Get-AbsolutePath $Directory).TrimEnd('\') + '\'
    return $candidateFull.StartsWith($directoryFull, [StringComparison]::OrdinalIgnoreCase)
}

function Read-JsonFile([string]$PathValue) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
        throw "Required JSON file does not exist: $PathValue"
    }
    try {
        return (Get-Content -LiteralPath $PathValue -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        throw "Invalid JSON in ${PathValue}: $($_.Exception.Message)"
    }
}

function Get-FileSha256([string]$PathValue) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($PathValue)
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function Get-StringSha256([string]$Value) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Assert-SafeIdentifier([string]$Value, [string]$Name) {
    if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "$Name contains unsafe characters: $Value"
    }
}

function Normalize-LockFileEntry($Entry) {
    if ($null -eq $Entry.path -or $Entry.path -isnot [string]) {
        throw "Every lock file entry must have a string path."
    }
    $relative = $Entry.path.Replace('\', '/')
    if ([System.IO.Path]::IsPathRooted($relative) -or $relative.Contains(':')) {
        throw "Lock paths must be relative: $relative"
    }
    $segments = $relative.Split('/')
    $invalidSegments = @($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' })
    if ($segments.Count -eq 0 -or $invalidSegments.Count -gt 0) {
        throw "Lock path contains an invalid segment: $relative"
    }
    if ($Entry.sha256 -isnot [string] -or $Entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw "Lock entry must contain a lowercase SHA-256: $relative"
    }
    if ($null -eq $Entry.size -or ([double]$Entry.size) -lt 0 -or ([double]$Entry.size) -ne [math]::Floor([double]$Entry.size)) {
        throw "Lock entry must contain a non-negative integer size: $relative"
    }
    return [pscustomobject]@{ path = $relative; size = [int64]$Entry.size; sha256 = $Entry.sha256 }
}

function Read-PayloadLock([string]$PathValue) {
    $lock = Read-JsonFile $PathValue
    if ($lock.schemaVersion -ne 1) { throw "Unsupported payload lock schemaVersion." }
    Assert-SafeIdentifier $lock.payload.name "payload.name"
    Assert-SafeIdentifier $lock.payload.version "payload.version"
    if ($lock.node.minimumVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "node.minimumVersion must be a semantic major.minor.patch version."
    }

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $files = @($lock.payload.files | ForEach-Object { Normalize-LockFileEntry $_ })
    if ($files.Count -eq 0) { throw "The payload lock contains no files." }
    foreach ($file in $files) {
        if (-not $seen.Add($file.path)) { throw "Duplicate lock path: $($file.path)" }
    }

    $required = @(
        'bin/launch.mjs', 'bin/native-bootstrap.mjs', 'bin/agent-readiness.mjs',
        'bin/kimi-cu-mcp.cmd', 'bundle.json', 'runtime/node-repl.exe',
        'runtime/kernel.mjs', 'runtime/trusted-worker.mjs', 'runtime/cell-compiler.mjs',
        'runtime/worker-runtime.mjs', 'runtime/image-output.mjs',
        'runtime/node_modules/meriyah/package.json',
        'public/node_modules/@kimi/cu/index.mjs', 'trusted-service/service.mjs',
        'skills/kimi-cu/SKILL.md', 'skills/kimi-cu/references/api.md',
        'skills/kimi-cu/references/repl.md'
    )
    foreach ($relative in $required) {
        if (-not $seen.Contains($relative)) { throw "Lock is missing required runtime file: $relative" }
    }

    # Sort ordinally so the fingerprint is reproducible outside PowerShell as well.
    $orderedPaths = New-Object 'System.Collections.Generic.List[string]'
    $filesByPath = @{}
    foreach ($file in $files) {
        [void]$orderedPaths.Add($file.path)
        $filesByPath[$file.path] = $file
    }
    $orderedPaths.Sort([System.StringComparer]::Ordinal)
    $fingerprintInput = @($lock.payload.name, $lock.payload.version)
    foreach ($filePath in $orderedPaths) {
        $entry = $filesByPath[$filePath]
        $fingerprintInput += "$filePath`0$($entry.size)`0$($entry.sha256)"
    }
    $fingerprint = Get-StringSha256 ($fingerprintInput -join "`n")
    return [pscustomobject]@{
        name = $lock.payload.name
        version = $lock.payload.version
        nodeMinimumVersion = $lock.node.minimumVersion
        files = $files
        fingerprint = $fingerprint
    }
}

function Assert-NoReparsePoints([string]$RootPath) {
    $items = @(Get-Item -LiteralPath $RootPath -Force) + @(Get-ChildItem -LiteralPath $RootPath -Recurse -Force)
    foreach ($item in $items) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse points are not allowed in a payload: $($item.FullName)"
        }
    }
}

function Assert-PayloadFiles([string]$RootPath, $Files, [switch]$RejectExtras) {
    # Resolve 8.3 short names so relative paths match Get-ChildItem output.
    $RootPath = Get-CanonicalPath $RootPath
    if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
        throw "Payload directory does not exist: $RootPath"
    }
    Assert-NoReparsePoints $RootPath
    $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $Files) {
        [void]$expected.Add($file.path)
        $fullPath = Join-Path $RootPath ($file.path.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Payload file is missing: $($file.path)"
        }
        $item = Get-Item -LiteralPath $fullPath -Force
        if ($item.Length -ne $file.size) {
            throw "Payload size mismatch for $($file.path): expected $($file.size), found $($item.Length)."
        }
        $actualHash = Get-FileSha256 $fullPath
        if ($actualHash -cne $file.sha256) {
            throw "Payload SHA-256 mismatch for $($file.path)."
        }
    }
    if ($RejectExtras) {
        $actualFiles = @(Get-ChildItem -LiteralPath $RootPath -Recurse -Force -File)
        foreach ($item in $actualFiles) {
            $relative = Get-RelativePayloadPath $RootPath $item.FullName
            if (-not $expected.Contains($relative)) {
                throw "Source contains a file not present in the lock: $relative"
            }
        }
        if ($actualFiles.Count -ne $Files.Count) {
            throw "Source file count does not match the payload lock."
        }
    }
}

function Assert-NodeVersion([string]$MinimumVersion) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "Node.js was not found on PATH. Install Node.js $MinimumVersion or newer." }
    $versionText = (& node -v).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v?(\d+\.\d+\.\d+)') {
        throw "Could not determine the Node.js version."
    }
    if ([version]$matches[1] -lt [version]$MinimumVersion) {
        throw "Node.js $MinimumVersion or newer is required; found $versionText."
    }
    $architecture = (& node -p "process.arch").Trim()
    if ($architecture -ne 'x64') {
        throw "An x64 Node.js runtime is required; found $architecture."
    }
}

function Assert-Preflight([string]$MinimumVersion) {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "This installer supports Windows only." }
    if (-not [Environment]::Is64BitOperatingSystem) { throw "A 64-bit Windows installation is required." }
    if (-not [Environment]::UserInteractive) { throw "An interactive Windows user session is required." }
    Assert-NodeVersion $MinimumVersion
}

function Copy-LockedPayload([string]$SourceRoot, [string]$StagingRoot, $Files) {
    New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null
    foreach ($file in $Files) {
        $source = Join-Path $SourceRoot ($file.path.Replace('/', '\'))
        $destination = Join-Path $StagingRoot ($file.path.Replace('/', '\'))
        $parent = Split-Path -Parent $destination
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

function New-PayloadState($Lock, [string]$PayloadPath) {
    return [pscustomobject]@{
        schemaVersion = 1
        name = $Lock.name
        version = $Lock.version
        nodeMinimumVersion = $Lock.nodeMinimumVersion
        fingerprint = $Lock.fingerprint
        path = $PayloadPath
        files = $Lock.files
        installedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
}

function Write-AtomicJson($Value, [string]$Destination) {
    $directory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Destination) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $json = $Value | ConvertTo-Json -Depth 12
        $encoding = New-Object Text.UTF8Encoding($false)
        $bytes = $encoding.GetBytes($json + [Environment]::NewLine)
        $stream = New-Object System.IO.FileStream($temporary, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        if (Test-Path -LiteralPath $Destination) {
            if (-not ('KimiCu.NativeMethods' -as [type])) {
                Add-Type -Namespace KimiCu -Name NativeMethods -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool MoveFileEx(string existingFile, string newFile, uint flags);
'@
            }
            # MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
            if (-not [KimiCu.NativeMethods]::MoveFileEx($temporary, $Destination, 9)) {
                $win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                throw "Atomic state replacement failed with Win32 error $win32Error."
            }
        } else {
            [IO.File]::Move($temporary, $Destination)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-StatePaths([string]$RootPath) {
    $state = Join-Path $RootPath 'state'
    return @{ current = Join-Path $state 'current.json'; previous = Join-Path $state 'previous.json' }
}

function Assert-State($State, [string]$RootPath) {
    if ($State.schemaVersion -ne 1 -or $null -eq $State.path -or $null -eq $State.files) {
        throw "Invalid installation state. Reinstall from a verified local payload."
    }
    $payloads = Join-Path $RootPath 'payloads'
    if (-not (Test-PathInside $State.path $payloads)) {
        throw "State points outside the managed payloads directory; refusing to use it."
    }
}

function Set-CurrentState($State, [string]$RootPath, [switch]$PreserveCurrent) {
    $paths = Get-StatePaths $RootPath
    if ($PreserveCurrent -and (Test-Path -LiteralPath $paths.current)) {
        $current = Read-JsonFile $paths.current
        if ($current.fingerprint -ne $State.fingerprint) {
            Write-AtomicJson $current $paths.previous
        }
    }
    Write-AtomicJson $State $paths.current
}

function Invoke-Install([string]$RootPath) {
    $sourceRoot = (Resolve-Path -LiteralPath $SourcePath).ProviderPath
    if ($sourceRoot.StartsWith('\\?\')) { $sourceRoot = $sourceRoot.Substring(4) }
    $sourceRoot = $sourceRoot.TrimEnd('\')
    $lock = Read-PayloadLock (Get-AbsolutePath $LockPath)
    Assert-Preflight $lock.nodeMinimumVersion
    Write-Host "Verifying $($lock.name) $($lock.version) from $sourceRoot"
    Assert-PayloadFiles $sourceRoot $lock.files -RejectExtras

    $payloadId = "$($lock.name)-$($lock.version)-$($lock.fingerprint.Substring(0, 12))"
    $payloadsRoot = Join-Path $RootPath 'payloads'
    $destination = Join-Path $payloadsRoot $payloadId
    if (-not (Test-PathInside $destination $payloadsRoot)) { throw "Unsafe payload destination." }

    if ($DryRun) {
        Write-Host "[DRY RUN] Verified $($lock.files.Count) files. Would install to $destination"
        return
    }
    New-Item -ItemType Directory -Path $payloadsRoot -Force | Out-Null

    $destinationHealthy = $false
    if (Test-Path -LiteralPath $destination) {
        try {
            Assert-PayloadFiles $destination $lock.files
            $destinationHealthy = $true
        } catch {
            Write-Warning "Existing payload failed verification and will be replaced: $($_.Exception.Message)"
        }
    }

    $currentPath = (Get-StatePaths $RootPath).current
    if (Test-Path -LiteralPath $currentPath) {
        $current = Read-JsonFile $currentPath
        Assert-State $current $RootPath
        if ($current.fingerprint -eq $lock.fingerprint -and $destinationHealthy) {
            Assert-PayloadFiles $current.path $current.files
            Write-Host "Payload $payloadId is already current; no state changes needed."
            return
        }
    }

    if ($destinationHealthy) {
        Write-Host "Reusing verified payload directory $destination"
    } else {
        $staging = Join-Path $payloadsRoot ('.' + $payloadId + '.staging-' + [Guid]::NewGuid().ToString('N'))
        $quarantine = $null
        if (Test-Path -LiteralPath $destination) {
            $quarantine = Join-Path $payloadsRoot ('.' + $payloadId + '.damaged-' + [Guid]::NewGuid().ToString('N'))
            Move-Item -LiteralPath $destination -Destination $quarantine
        }
        try {
            Copy-LockedPayload $sourceRoot $staging $lock.files
            Assert-PayloadFiles $staging $lock.files -RejectExtras
            Move-Item -LiteralPath $staging -Destination $destination
        } catch {
            if ($quarantine -and -not (Test-Path -LiteralPath $destination)) {
                Move-Item -LiteralPath $quarantine -Destination $destination
                $quarantine = $null
            }
            throw
        } finally {
            if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
            if ($quarantine -and (Test-Path -LiteralPath $quarantine)) {
                Remove-Item -LiteralPath $quarantine -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Set-CurrentState (New-PayloadState $lock $destination) $RootPath -PreserveCurrent
    Write-Host "Installed payload $payloadId"
    Write-Host "Current state: $currentPath"
}

function Invoke-Rollback([string]$RootPath) {
    $paths = Get-StatePaths $RootPath
    $current = Read-JsonFile $paths.current
    $previous = Read-JsonFile $paths.previous
    Assert-State $current $RootPath
    Assert-State $previous $RootPath
    Assert-PayloadFiles $previous.path $previous.files
    if ($DryRun) {
        Write-Host "[DRY RUN] Would roll back from $($current.version) to $($previous.version)."
        return
    }
    Write-AtomicJson $current $paths.previous
    Write-AtomicJson $previous $paths.current
    Write-Host "Rolled back to $($previous.name) $($previous.version) at $($previous.path)"
}

function Invoke-Doctor([string]$RootPath) {
    $paths = Get-StatePaths $RootPath
    $current = Read-JsonFile $paths.current
    Assert-State $current $RootPath
    $minimumVersion = '24.15.0'
    $minimumProperty = $current.PSObject.Properties['nodeMinimumVersion']
    if ($null -ne $minimumProperty -and $minimumProperty.Value) {
        $minimumVersion = [string]$minimumProperty.Value
    }
    Assert-NodeVersion $minimumVersion
    Assert-PayloadFiles $current.path $current.files
    $result = [ordered]@{
        ok = $true
        name = $current.name
        version = $current.version
        fingerprint = $current.fingerprint
        path = $current.path
        filesVerified = @($current.files).Count
        node = (& node -v).Trim()
    }
    $result | ConvertTo-Json -Depth 4
}

function Invoke-Uninstall([string]$RootPath) {
    $paths = Get-StatePaths $RootPath
    $states = @()
    foreach ($path in @($paths.current, $paths.previous)) {
        if (Test-Path -LiteralPath $path) { $states += Read-JsonFile $path }
    }
    foreach ($state in $states) { Assert-State $state $RootPath }
    if ($DryRun) {
        Write-Host "[DRY RUN] Would remove $($states.Count) state record(s) and their managed payload directories."
        return
    }
    $removed = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($state in $states) {
        if ($removed.Add((Get-AbsolutePath $state.path)) -and (Test-Path -LiteralPath $state.path -PathType Container)) {
            Remove-Item -LiteralPath $state.path -Recurse -Force
        }
    }
    foreach ($path in @($paths.current, $paths.previous)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    Write-Host "Removed community-managed state and referenced payloads. Other files were left untouched."
}

if (-not $InstallRoot) { throw "LOCALAPPDATA is unavailable; pass -InstallRoot explicitly." }
$InstallRoot = Get-AbsolutePath $InstallRoot
$mutexName = 'Local\KimiCU-Community-' + (Get-StringSha256 $InstallRoot.ToLowerInvariant())
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$lockTaken = $false
$exitCode = 0
try {
    try {
        $lockTaken = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $lockTaken = $true
    }
    if (-not $lockTaken) { throw "Another installer is already operating on $InstallRoot." }

    switch ($PSCmdlet.ParameterSetName) {
        'Install' { Invoke-Install $InstallRoot }
        'Rollback' { Invoke-Rollback $InstallRoot }
        'Doctor' { Invoke-Doctor $InstallRoot }
        'Uninstall' { Invoke-Uninstall $InstallRoot }
    }
} catch {
    [Console]::Error.WriteLine("Setup failed: $($_.Exception.Message)")
    if ($VerbosePreference -eq 'Continue') {
        [Console]::Error.WriteLine($_.ScriptStackTrace)
    }
    $exitCode = 1
} finally {
    if ($lockTaken) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
