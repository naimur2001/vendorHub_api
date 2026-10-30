# test-uploads.ps1
# Run from the project root while "npm run dev" is running in another terminal.
$root = 'http://localhost:4000'
$base = "$root/api/v1"
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''

function Call($method, $path, $token, $body) {
    $script:lastMsg = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null } }
        $text = $_.ErrorDetails.Message
        if (-not $text) {
            try { $text = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { $text = '' }
        }
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
        return @{ status = [int]$resp.StatusCode; json = $json }
    }
}

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) {
        Write-Host "PASS  $name" -ForegroundColor Green
        $script:pass++
    } else {
        $extra = ''
        if ($script:lastMsg) { $extra = " | server said: $($script:lastMsg)" }
        Write-Host "FAIL  $name (got '$actual', expected '$expected')$extra" -ForegroundColor Red
        $script:fail++
    }
}

function Login($email) {
    $r = Call 'POST' '/auth/login' $null @{ email = $email; password = 'Password123!' }
    if ($r.status -ne 200) {
        Write-Host "Login failed for $email (status $($r.status))" -ForegroundColor Red
        exit 1
    }
    return $r.json.data.accessToken
}

function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        exit 1
    }
}

# multipart upload with curl.exe (PowerShell 5.1 cannot send files itself)
$tmp = Join-Path $env:TEMP 'vh-upload-test'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
function Upload($token, $purpose, $file, $mime) {
    $script:lastMsg = ''
    $out = Join-Path $tmp 'resp.json'
    if (Test-Path $out) { Remove-Item $out }
    $cArgs = @('-s', '-o', $out, '-w', '%{http_code}', '-X', 'POST')
    if ($token) { $cArgs += @('-H', "Authorization: Bearer $token") }
    $cArgs += @('-F', "file=@$file;type=$mime", "$base/uploads?purpose=$purpose")
    $code = & curl.exe @cArgs
    $json = $null
    if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
    return @{ status = [int]$code; json = $json }
}

# plain GET that does not parse JSON (images and PDFs)
function Fetch($url, $token) {
    $params = @{ Uri = $url; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    try {
        $r = Invoke-WebRequest @params
        return @{ status = [int]$r.StatusCode; type = [string]$r.Headers['Content-Type'] }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; type = '' } }
        return @{ status = [int]$resp.StatusCode; type = '' }
    }
}

try { Invoke-WebRequest -Uri "$root/health" -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    Write-Host 'curl.exe was not found (it ships with Windows 10 and 11).' -ForegroundColor Red
    exit 1
}

$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$admin = Login 'admin@vendorshub.test'

# test files
$png = Join-Path $tmp 'tiny.png'
[IO.File]::WriteAllBytes($png, [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='))
$pdf = Join-Path $tmp 'license.pdf'
[IO.File]::WriteAllText($pdf, "%PDF-1.4`n1 0 obj << >> endobj`ntrailer << >>`n%%EOF")
$fake = Join-Path $tmp 'fake.png'
[IO.File]::WriteAllText($fake, 'this is not an image, only text with a .png name')
$big = Join-Path $tmp 'big.png'
$bigBytes = New-Object byte[] (6MB)
[Array]::Copy([Convert]::FromBase64String('iVBORw0KGgo='), $bigBytes, 8)
[IO.File]::WriteAllBytes($big, $bigBytes)

# ---- 1. access and input ----
$r = Upload $null 'PUBLIC_IMAGE' $png 'image/png'
Check 'an upload needs a login' $r.status 401
$r = Upload $cust 'SOMETHING' $png 'image/png'
Check 'an unknown purpose is rejected' $r.status 400
$r = Call 'POST' '/uploads?purpose=PUBLIC_IMAGE' $cust $null
Check 'a request without a file is rejected' $r.status 400

# ---- 2. a public image ----
$r = Upload $cust 'PUBLIC_IMAGE' $png 'image/png'
Check 'a PNG uploads as a public image' $r.status 201
$pubUrl = $r.json.data.url
Need $pubUrl 'the public upload'
Check 'the link points to the public folder' ($pubUrl -like "$root/uploads/public/*.png") $true
Check 'the type is detected as PNG' $r.json.data.mimeType 'image/png'
Check 'the size is recorded' ($r.json.data.size -gt 0) $true
$f = Fetch $pubUrl $null
Check 'anyone can open a public image' $f.status 200
Check 'it is served as a PNG' ($f.type -like 'image/png*') $true
$r = Call 'PATCH' '/users/me' $cust @{ avatarUrl = $pubUrl }
Check 'the link is accepted as an avatar' $r.status 200

# ---- 3. type and size checks ----
$r = Upload $cust 'PUBLIC_IMAGE' $fake 'image/png'
Check 'a text file named .png is rejected' $r.status 400
$r = Upload $cust 'PUBLIC_IMAGE' $pdf 'application/pdf'
Check 'a PDF is not allowed as a public image' $r.status 400
$r = Upload $cust 'PUBLIC_IMAGE' $big 'image/png'
Check 'a file over 5 MB is rejected' $r.status 413

# ---- 4. a private document ----
$r = Upload $owner 'PRIVATE_DOCUMENT' $pdf 'application/pdf'
Check 'a PDF uploads as a private document' $r.status 201
$privUrl = $r.json.data.url
Need $privUrl 'the private upload'
Check 'the link goes through the API' ($privUrl -like "$base/files/*") $true
$f = Fetch $privUrl $null
Check 'a private document needs a login' $f.status 401
$f = Fetch $privUrl $owner
Check 'the uploader can open it' $f.status 200
Check 'it is served as a PDF' ($f.type -like 'application/pdf*') $true
$f = Fetch $privUrl $cust
Check 'another user gets 404' $f.status 404
$f = Fetch $privUrl $admin
Check 'an admin can open it' $f.status 200
$f = Fetch "$root/uploads/private/anything.pdf" $null
Check 'the private folder is not served publicly' $f.status 404
$r = Upload $owner 'PRIVATE_DOCUMENT' $png 'application/pdf'
Check 'a PNG labelled as PDF is still accepted as a document' $r.status 201
Check 'the stored type comes from the content, not the label' $r.json.data.mimeType 'image/png'

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host "Test files were uploaded into the uploads folder (it is gitignored)."