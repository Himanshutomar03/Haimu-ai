# ============================================================
# compile-affhook.ps1 — Finds a C compiler and builds AffHook.dll
#
# Tries in order:
#   1. cl.exe  (Visual Studio / Build Tools)
#   2. gcc.exe (MinGW-w64 / MSYS2)
#   3. tcc.exe (Tiny C Compiler)
#   4. Auto-download TCC if nothing found
#
# Output: OK:<compiler> or ERR:<reason>
# ============================================================

$ErrorActionPreference = "SilentlyContinue"

$srcFile  = Join-Path $PSScriptRoot "affhook.c"
$outFile  = Join-Path $PSScriptRoot "AffHook.dll"
$logFile  = Join-Path $env:TEMP "AffHook-compile.log"

function Write-CompileLog {
    param([string]$msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$ts] $msg" -ErrorAction SilentlyContinue
}

if (-not (Test-Path $srcFile)) {
    Write-Output "ERR:SourceNotFound"
    exit 1
}

# ── 1. Try cl.exe (Visual Studio) ─────────────────────────────────────
function Try-MSVC {
    Write-CompileLog "Trying MSVC cl.exe..."

    # Use vswhere to find VS installation
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vsWhere)) {
        # Try alternative location
        $vsWhere = "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
    }

    if (Test-Path $vsWhere) {
        $vsPath = & $vsWhere -latest -property installationPath 2>$null
        if ($vsPath) {
            # Find vcvars64.bat
            $vcvars = Get-ChildItem -Path "$vsPath\VC\Auxiliary\Build\vcvars64.bat" -ErrorAction SilentlyContinue
            if ($vcvars) {
                $cmd = "`"$($vcvars.FullName)`" >nul 2>&1 && cl /LD /O2 /MT /nologo `"$srcFile`" /Fe:`"$outFile`" user32.lib kernel32.lib /link /NOLOGO"
                Write-CompileLog "Running: cmd /c $cmd"
                $result = & cmd /c $cmd 2>&1
                Write-CompileLog "Result: $result"
                if (Test-Path $outFile) {
                    # Clean up .obj, .lib, .exp files
                    Remove-Item (Join-Path $PSScriptRoot "affhook.obj") -ErrorAction SilentlyContinue
                    Remove-Item (Join-Path $PSScriptRoot "AffHook.lib") -ErrorAction SilentlyContinue
                    Remove-Item (Join-Path $PSScriptRoot "AffHook.exp") -ErrorAction SilentlyContinue
                    return $true
                }
            }
        }
    }

    # Also check PATH for cl.exe directly (Build Tools or Developer Command Prompt)
    $cl = Get-Command cl.exe -ErrorAction SilentlyContinue
    if ($cl) {
        & cl.exe /LD /O2 /MT /nologo "$srcFile" "/Fe:$outFile" user32.lib kernel32.lib /link /NOLOGO 2>&1 | Out-Null
        if (Test-Path $outFile) {
            Remove-Item (Join-Path $PSScriptRoot "affhook.obj") -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $PSScriptRoot "AffHook.lib") -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $PSScriptRoot "AffHook.exp") -ErrorAction SilentlyContinue
            return $true
        }
    }

    return $false
}

# ── 2. Try gcc (MinGW-w64) ────────────────────────────────────────────
function Try-GCC {
    Write-CompileLog "Trying GCC..."

    # Check PATH first
    $gcc = Get-Command gcc.exe -ErrorAction SilentlyContinue
    if (-not $gcc) {
        # Check common MinGW locations
        $paths = @(
            "C:\msys64\mingw64\bin\gcc.exe",
            "C:\mingw64\bin\gcc.exe",
            "C:\mingw-w64\bin\gcc.exe",
            "C:\MinGW\bin\gcc.exe",
            "C:\tools\mingw64\bin\gcc.exe"
        )
        foreach ($p in $paths) {
            if (Test-Path $p) { $gcc = @{ Source = $p }; break }
        }
    }

    if ($gcc) {
        $gccPath = if ($gcc.Source) { $gcc.Source } else { "gcc.exe" }
        & $gccPath -shared -O2 -s -o "$outFile" "$srcFile" -luser32 -lkernel32 2>&1 | Out-Null
        if (Test-Path $outFile) { return $true }
    }

    return $false
}

# ── 3. Try tcc (Tiny C Compiler) ──────────────────────────────────────
function Try-TCC {
    Write-CompileLog "Trying TCC..."

    $tcc = Get-Command tcc.exe -ErrorAction SilentlyContinue
    if ($tcc) {
        & tcc.exe -shared -o "$outFile" "$srcFile" -luser32 -lkernel32 2>&1 | Out-Null
        if (Test-Path $outFile) { return $true }
    }

    return $false
}

# ── 4. Download TCC (portable, ~1.5MB) ────────────────────────────────
function Try-DownloadTCC {
    Write-CompileLog "Downloading TCC..."

    $tccDir = Join-Path $env:LOCALAPPDATA "QuickSearch\tcc"
    $tccExe = Join-Path $tccDir "tcc.exe"

    if (Test-Path $tccExe) {
        & $tccExe -shared -o "$outFile" "$srcFile" -luser32 -lkernel32 2>&1 | Out-Null
        if (Test-Path $outFile) { return $true }
    }

    try {
        $zipUrl = "http://download.savannah.gnu.org/releases/tinycc/tcc-0.9.27-win64-bin.zip"
        $zipFile = Join-Path $env:TEMP "tcc-win64.zip"

        if (-not (Test-Path $tccDir)) { New-Item -ItemType Directory -Path $tccDir -Force | Out-Null }

        # Download
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing -TimeoutSec 30

        # Extract
        Expand-Archive -Path $zipFile -DestinationPath $tccDir -Force

        # TCC extracts into a subdirectory
        $tccSub = Get-ChildItem -Path $tccDir -Directory -Filter "tcc*" | Select-Object -First 1
        if ($tccSub) {
            $actualTcc = Join-Path $tccSub.FullName "tcc.exe"
            if (Test-Path $actualTcc) {
                & $actualTcc -shared -o "$outFile" "$srcFile" -luser32 -lkernel32 2>&1 | Out-Null
                if (Test-Path $outFile) {
                    Remove-Item $zipFile -ErrorAction SilentlyContinue
                    return $true
                }
            }
        }

        Remove-Item $zipFile -ErrorAction SilentlyContinue
    } catch {
        Write-CompileLog "TCC download failed: $($_.Exception.Message)"
    }

    return $false
}

# ── Run compilation attempts ──────────────────────────────────────────
Write-CompileLog "Starting AffHook.dll compilation..."

if (Test-Path $outFile) {
    Write-CompileLog "AffHook.dll already exists, skipping compilation"
    Write-Output "OK:exists"
    exit 0
}

if (Try-MSVC) {
    Write-CompileLog "Success: compiled with cl.exe (MSVC)"
    Write-Output "OK:cl"
    exit 0
}

if (Try-GCC) {
    Write-CompileLog "Success: compiled with gcc (MinGW)"
    Write-Output "OK:gcc"
    exit 0
}

if (Try-TCC) {
    Write-CompileLog "Success: compiled with tcc"
    Write-Output "OK:tcc"
    exit 0
}

if (Try-DownloadTCC) {
    Write-CompileLog "Success: compiled with downloaded tcc"
    Write-Output "OK:tcc-download"
    exit 0
}

Write-CompileLog "ERROR: No C compiler found and TCC download failed"
Write-Output "ERR:NoCompiler"
exit 1
