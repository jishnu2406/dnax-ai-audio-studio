param([switch]$Cpu)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RvcRoot = Join-Path $AppRoot 'vendor\rvc'
$VenvRoot = Join-Path $AppRoot '.venv'
$PythonPath = Join-Path $VenvRoot 'Scripts\python.exe'
$ManagedPython = Join-Path $AppRoot '.runtime\python'
$env:UV_PYTHON_INSTALL_DIR = $ManagedPython
$env:UV_CACHE_DIR = Join-Path $AppRoot '.runtime\uv-cache'

if (-not (Test-Path (Join-Path $RvcRoot 'webui.py'))) {
    if ((Test-Path (Join-Path $AppRoot '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        git -C $AppRoot submodule update --init -- vendor/rvc
        if ($LASTEXITCODE -ne 0) { throw 'Could not download the pinned RVC submodule.' }
    }
    if (-not (Test-Path (Join-Path $RvcRoot 'webui.py'))) {
        throw 'RVC source is missing. Clone this repository with Git, then run setup.ps1 again.'
    }
}
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'uv is required. Install it from https://docs.astral.sh/uv/getting-started/installation/'
}

New-Item -ItemType Directory -Path (Join-Path $AppRoot '.runtime') -Force | Out-Null
if (-not (Test-Path $PythonPath)) {
    uv python install 3.12 --install-dir $ManagedPython --no-registry --no-bin
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 installation failed.' }
    uv venv --python 3.12 $VenvRoot
    if ($LASTEXITCODE -ne 0) { throw 'Creating the Python environment failed.' }
}

if ($Cpu) {
    Write-Host 'Installing the CPU version of RVC dependencies...'
    $RequirementsSource = Join-Path $RvcRoot 'requirments_cpu_py312.txt'
    $ExtraIndex = 'https://download.pytorch.org/whl/cpu'
} else {
    Write-Host 'Installing CUDA 11.8 Torch for NVIDIA RTX 20/30/40 series...'
    uv pip install --python $PythonPath --index-strategy unsafe-best-match --index-url https://download.pytorch.org/whl/cu118 --extra-index-url https://pypi.org/simple 'torch==2.7.1+cu118' 'torchaudio==2.7.1+cu118'
    if ($LASTEXITCODE -ne 0) { throw 'CUDA Torch installation failed.' }
    $RequirementsSource = Join-Path $RvcRoot 'requirments_cu118_py312.txt'
}

# The upstream requirements pin a China-specific mirror. Use the official index here.
$RequirementsCopy = Join-Path $AppRoot '.runtime\requirements-official.txt'
Get-Content $RequirementsSource | Where-Object { $_ -notmatch '^\s*--(extra-)?index-url\s' } | Set-Content $RequirementsCopy
if ($Cpu) {
    uv pip install --python $PythonPath --index-strategy unsafe-best-match --index-url https://pypi.org/simple --extra-index-url $ExtraIndex -r $RequirementsCopy
} else {
    uv pip install --python $PythonPath --index-url https://pypi.org/simple -r $RequirementsCopy
}
if ($LASTEXITCODE -ne 0) { throw 'RVC dependency installation failed.' }
uv pip install --python $PythonPath --index-url https://pypi.org/simple huggingface_hub
if ($LASTEXITCODE -ne 0) { throw 'Hugging Face downloader installation failed.' }

uv pip install --python $PythonPath --index-url https://pypi.org/simple 'deepfilternet-rs==0.1.1' 'git+https://github.com/openmirlab/demucs-infer.git@a8552bb9da29a56018ae2f1828d360cc60830b54'
if ($LASTEXITCODE -ne 0) { throw 'Local speech enhancement dependency installation failed.' }

& $PythonPath (Join-Path $AppRoot 'download_models.py')
if ($LASTEXITCODE -ne 0) { throw 'RVC model download failed.' }
Write-Host 'Setup complete. Run: npm start'
