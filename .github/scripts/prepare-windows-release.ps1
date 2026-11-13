$ErrorActionPreference = 'Stop'
if (-not $env:RELEASE_TAG -or -not $env:RELEASE_TAG.StartsWith('v')) {
    throw 'RELEASE_TAG must be set to a version tag, for example v0.1.0.'
}

$version = $env:RELEASE_TAG.Substring(1)
$name = "package-tracking-$version-windows-x64"
$releaseDir = 'src-tauri/target/release'
$installers = @(Get-ChildItem -LiteralPath "$releaseDir/bundle/nsis" -Filter '*-setup.exe' -File)
if ($installers.Count -ne 1) {
    throw "Expected exactly one Windows installer, found $($installers.Count)."
}

New-Item -ItemType Directory -Force -Path 'release-assets', 'release-portable' | Out-Null
Copy-Item -LiteralPath $installers[0].FullName -Destination "release-assets/$name-setup.exe"
Copy-Item -LiteralPath "$releaseDir/package-tracking.exe" -Destination 'release-portable'
if (Test-Path -LiteralPath "$releaseDir/WebView2Loader.dll") {
    Copy-Item -LiteralPath "$releaseDir/WebView2Loader.dll" -Destination 'release-portable'
}
Compress-Archive -Path 'release-portable/*' -DestinationPath "release-assets/$name-portable.zip" -Force

$checksums = Get-ChildItem -LiteralPath 'release-assets' -File |
    Where-Object { $_.Extension -in '.exe', '.zip' } |
    Sort-Object Name |
    ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $($_.Name)"
    }
$checksums | Set-Content -LiteralPath 'release-assets/SHA256SUMS.txt' -Encoding ascii
