# OMH Coding Agent Installer for Windows
# Usage: irm https://raw.githubusercontent.com/humanfia/oh-my-humanize/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/humanfia/oh-my-humanize/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/humanfia/oh-my-humanize/main/scripts/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/humanfia/oh-my-humanize/main/scripts/install.ps1))) -Source -Ref <branch-tag-or-commit>
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/humanfia/oh-my-humanize/main/scripts/install.ps1))) -Binary -Ref <release-tag>

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

$Repo = "humanfia/oh-my-humanize"
$DefaultRef = if ($env:OMH_INSTALL_REF) { $env:OMH_INSTALL_REF } else { "main" }
$InstallDir = if ($env:OMH_INSTALL_DIR) { $env:OMH_INSTALL_DIR } elseif ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omh" }
$BinaryName = "omh-windows-x64.exe"
$MinimumBunVersion = "1.3.14"

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Bun $MinimumVersion or newer is required. Current version: $currentText. Upgrade Bun at https://bun.sh/docs/installation"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Check Git Bash first (most common on Windows)
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    # Check bash.exe on PATH (Cygwin, MSYS2, WSL)
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".omp\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json -AsHashtable
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "✓ Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "⚠ No bash shell found!" -ForegroundColor Yellow
            Write-Host "  OMH requires a bash shell on Windows. Options:" -ForegroundColor Yellow
            Write-Host "    1. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Yellow
            Write-Host "    2. Use WSL, Cygwin, or MSYS2" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  After installing, you can set a custom path in:" -ForegroundColor Yellow
            Write-Host "    $settingsFile" -ForegroundColor Yellow
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Yellow
        }
    } catch {
        Write-Host "⚠ Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    irm bun.sh/install.ps1 | iex
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    Assert-BunVersion $MinimumBunVersion
}

function Show-OmhPathHint {
    try {
        $command = Get-Command omh -ErrorAction Stop
        Write-Host "Run 'omh' to get started: $($command.Source)"
    } catch {
        Write-Host "Installed omh, but it is not on PATH yet." -ForegroundColor Yellow
        Write-Host "Add Bun's global bin to PATH, then run omh." -ForegroundColor Yellow
    }
}

function Install-ViaBun {
    $installRef = if ($Ref) { $Ref } else { $DefaultRef }
    Write-Host "Installing OMH from $Repo@$installRef via bun..."
    if (-not (Test-GitInstalled)) {
        throw "git is required when installing OMH from source"
    }

    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omh-install-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

    try {
        $repoUrl = "https://github.com/$Repo.git"
        $cloneOk = $false
        try {
            git clone --depth 1 --branch $installRef $repoUrl $tmpRoot | Out-Null
            $cloneOk = $true
        } catch {
            $cloneOk = $false
        }

        if (-not $cloneOk) {
            git clone $repoUrl $tmpRoot | Out-Null
            Push-Location $tmpRoot
            try {
                git checkout $installRef | Out-Null
            } finally {
                Pop-Location
            }
        }

        # Pull LFS files
        if (Test-GitLfsInstalled) {
            Push-Location $tmpRoot
            try {
                git lfs pull | Out-Null
            } finally {
                Pop-Location
            }
        }

        $packagePath = Join-Path $tmpRoot "packages\coding-agent"
        if (-not (Test-Path $packagePath)) {
            throw "Expected package at $packagePath"
        }

        bun install -g $packagePath
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install from $packagePath via bun"
        }
    } finally {
        Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "✓ Installed omh from $Repo@$installRef via bun" -ForegroundColor Green

    Configure-BashShell

    Show-OmhPathHint
}

function Install-Binary {
    if ($Ref) {
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Ref"
        } catch {
            throw "Release tag not found: $Ref`nFor branch/commit installs, use -Source with -Ref."
        }
    } else {
        Write-Host "Fetching latest release..."
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Download binary
    $BinaryUrl = "https://github.com/$Repo/releases/download/$Latest/$BinaryName"
    Write-Host "Downloading $BinaryName..."
    $OutPath = Join-Path $InstallDir "omh.exe"
    $CompatOutPath = Join-Path $InstallDir "omp.exe"
    Invoke-WebRequest -Uri $BinaryUrl -OutFile $OutPath
    Copy-Item -Force $OutPath $CompatOutPath

    Write-Host ""
    Write-Host "✓ Installed omh to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $needsRestart = $UserPath -notlike "*$InstallDir*"
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    }

    Configure-BashShell

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'omh' to get started!"
    } else {
        Write-Host "Run 'omh' to get started!"
    }
}

# Main logic
if ($Ref -and -not $Source -and -not $Binary) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
} elseif ($Binary) {
    Install-Binary
} else {
    # Default: install current OMH source from main so one-line installs do not
    # depend on an npm package with the old project name.
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
}
