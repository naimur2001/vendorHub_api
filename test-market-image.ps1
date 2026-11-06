# test-market-image.ps1 (admin market photo: upload security, serving, replace, delete, audit, rate limit)
# Run from the project root on fresh seed data while "npm run dev" is running. Uses curl.exe.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "FAIL  $name (got '$actual', expected '$expected')" -ForegroundColor Red; $script:fail++ }
}
function Call($method, $path, $token, $body) {
    $p = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $p.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) { $p.ContentType = 'application/json'; $p.Body = ($body | ConvertTo-Json -Compress) }
    try { $r = Invoke-WebRequest @p; return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) } }
    catch { if ($_.Exception.Response) { return @{ status = [int]$_.Exception.Response.StatusCode; json = $null } } return @{ status = 0; json = $null } }
}
function Login($email) {
    $r = Call 'POST' '/auth/login' $null @{ email = $email; password = 'Password123!' }
    if ($r.status -ne 200) { Write-Host "Login failed for $email" -ForegroundColor Red; exit 1 }
    return $r.json.data.accessToken
}
# a public file: status, type, nosniff and the bytes as text (to search inside)
function Fetch($url) {
    try {
        $r = Invoke-WebRequest $url -UseBasicParsing
        $text = [Text.Encoding]::ASCII.GetString([byte[]]$r.Content)
        return @{ status = [int]$r.StatusCode; type = [string]$r.Headers['Content-Type']; nosniff = [string]$r.Headers['X-Content-Type-Options']; text = $text }
    } catch {
        if ($_.Exception.Response) { return @{ status = [int]$_.Exception.Response.StatusCode } }
        return @{ status = 0 }
    }
}

try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }

$tmp = Join-Path $env:TEMP 'vh-market-image'
node scripts/make-image-fixtures.mjs $tmp | Out-Null
function MediaCount { return @(Get-ChildItem 'uploads\media' -Filter *.webp -ErrorAction SilentlyContinue).Count }

# multipart upload with curl.exe; $files is a list of "field=filename;type=mime"
function Send($url, $method, $token, $files) {
    $out = Join-Path $tmp 'resp.json'
    if (Test-Path $out) { Remove-Item $out }
    $cargs = @('-s', '-o', $out, '-w', '%{http_code}', '-X', $method)
    if ($token) { $cargs += @('-H', "Authorization: Bearer $token") }
    foreach ($f in $files) {
        $parts = $f -split '=', 2
        $nameType = $parts[1] -split ';type=', 2
        $cargs += @('-F', "$($parts[0])=@$(Join-Path $tmp $nameType[0]);type=$($nameType[1])")
    }
    $code = & curl.exe @cargs $url
    $json = $null
    if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    return @{ status = [int]$code; json = $json }
}

$admin = Login 'admin@vendorshub.test'
$customer = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$market = @((Call 'GET' '/markets' $null $null).json.data)[0]
$url = "$base/admin/markets/$($market.id)/image"
function Put($file, $type, $token) { return Send $url 'PUT' $token @("image=$file;type=$type") }

# ---- 1. access ----
Check 'logged out: 401' (Put 'valid.jpg' 'image/jpeg' $null).status 401
Check 'a customer: 403' (Put 'valid.jpg' 'image/jpeg' $customer).status 403
Check 'a shop owner: 403' (Put 'valid.jpg' 'image/jpeg' $owner).status 403
$unknown = Send "$base/admin/markets/00000000-0000-4000-8000-000000000000/image" 'PUT' $admin @('image=valid.jpg;type=image/jpeg')
Check 'an unknown market: 404' $unknown.status 404

# ---- 2. valid photos: always stored and served as WebP ----
foreach ($v in @(@('valid.jpg', 'image/jpeg'), @('valid.png', 'image/png'), @('valid.webp', 'image/webp'))) {
    $r = Put $v[0] $v[1] $admin
    Check "$($v[0]) is accepted" $r.status 200
}
$img = (Call 'GET' "/markets/$($market.slug)" $null $null).json.data.image
Check 'the public market shows the photo' ([bool]$img.url) $true
Check 'the photo URL is on our own origin' ($img.url -like 'http://localhost:4000/media/*.webp') $true
Check 'width and height are given' (($img.width -gt 0) -and ($img.height -gt 0)) $true
$f = Fetch $img.url
Check 'the photo is served' $f.status 200
Check 'it is served as WebP' ($f.type -like 'image/webp*') $true
Check 'with nosniff' $f.nosniff 'nosniff'
Check 'the stored file really is WebP' ($f.text.Substring(0, 4) + $f.text.Substring(8, 4)) 'RIFFWEBP'
Check 'the thumbnail is served' (Fetch $img.thumbUrl).status 200
$listed = @((Call 'GET' '/markets' $null $null).json.data | Where-Object { $_.id -eq $market.id })[0]
Check 'the market list shows the photo too' $listed.image.url $img.url

# ---- 3. EXIF/GPS and polyglot content never reach the served file ----
Check 'a JPEG with GPS is accepted' (Put 'gps.jpg' 'image/jpeg' $admin).status 200
$g = Fetch (Call 'GET' "/markets/$($market.slug)" $null $null).json.data.image.url
Check 'the served file has no EXIF block' ($g.text.Contains('EXIF') -or $g.text.Contains('Exif')) $false
Check 'the served file has no EXIF text' $g.text.Contains('secret-artist') $false
Check 'a polyglot JPEG is accepted' (Put 'polyglot.jpg' 'image/jpeg' $admin).status 200
$pg = (Call 'GET' "/markets/$($market.slug)" $null $null).json.data.image
Check 'the served file has no script' (Fetch $pg.url).text.Contains('<script>') $false
Check 'the thumbnail has no script' (Fetch $pg.thumbUrl).text.Contains('<script>') $false

# ---- 4. rejected files: 400, and nothing is stored ----
$before = MediaCount
$rejected = @(
    @('plain.svg', 'image/svg+xml'), @('script.svg', 'image/svg+xml'), @('page.png', 'image/png'),
    @('code.jpg', 'image/jpeg'), @('shell.jpg', 'image/jpeg'), @('doc.pdf', 'application/pdf'),
    @('anim.gif', 'image/gif'), @('empty.jpg', 'image/jpeg'), @('text.png', 'image/png'), @('bomb.png', 'image/png')
)
foreach ($x in $rejected) { Check "$($x[0]) is rejected" (Put $x[0] $x[1] $admin).status 400 }
Check 'a rejected file gets the fixed message' (Put 'script.svg' 'image/svg+xml' $admin).json.error.message 'Only JPG, PNG or WebP photos are allowed'
Check 'two files in one request: 400' (Send $url 'PUT' $admin @('image=valid.jpg;type=image/jpeg', 'image=valid.png;type=image/png')).status 400
Check 'a wrong field name: 400' (Send $url 'PUT' $admin @('photo=valid.jpg;type=image/jpeg')).status 400
Check 'a 6 MB file: 413' (Put 'huge.jpg' 'image/jpeg' $admin).status 413
Check 'a 400 x 200 photo: 422' (Put 'small.jpg' 'image/jpeg' $admin).status 422
Check 'nothing was stored for the rejected files' (MediaCount) $before
Check 'the market still shows the previous photo' (Call 'GET' "/markets/$($market.slug)" $null $null).json.data.image.url $pg.url

# ---- 5. replacing deletes the old files ----
Check 'a new photo replaces the old one' (Put 'replace.jpg' 'image/jpeg' $admin).status 200
$new = (Call 'GET' "/markets/$($market.slug)" $null $null).json.data.image
Check 'the new photo is shown' ($new.url -ne $pg.url) $true
Check 'the old photo file is gone' (Fetch $pg.url).status 404
Check 'the old thumbnail file is gone' (Fetch $pg.thumbUrl).status 404

# ---- 6. delete ----
$d = Call 'DELETE' "/admin/markets/$($market.id)/image" $admin $null
Check 'the admin removes the photo' $d.status 200
Check 'the public image is null' ($null -eq (Call 'GET' "/markets/$($market.slug)" $null $null).json.data.image) $true
Check 'the photo file is gone' (Fetch $new.url).status 404
Check 'the thumbnail file is gone' (Fetch $new.thumbUrl).status 404
Check 'removing again: 404' (Call 'DELETE' "/admin/markets/$($market.id)/image" $admin $null).status 404
Check 'a customer cannot remove: 403' (Call 'DELETE' "/admin/markets/$($market.id)/image" $customer $null).status 403

# ---- 7. audit log ----
$logs = @((Call 'GET' "/admin/audit-logs?entityType=Market&entityId=$($market.id)&limit=50" $admin $null).json.data | ForEach-Object { $_.action })
Check 'the audit log has market_image_set' ($logs -contains 'catalog.market_image_set') $true
Check 'the audit log has market_image_removed' ($logs -contains 'catalog.market_image_removed') $true

# ---- 8. rate limit: 20 accepted uploads per 10 minutes per user ----
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$reg = Call 'POST' '/auth/register' $null @{ name = 'Rate Tester'; email = "rate$stamp@vendorshub.test"; password = 'Password123!' }
$fresh = $reg.json.data.accessToken
$ok = 0
for ($i = 1; $i -le 20; $i++) {
    if ((Send "$base/uploads?purpose=PUBLIC_IMAGE" 'POST' $fresh @('file=valid.jpg;type=image/jpeg')).status -eq 201) { $ok++ }
}
Check '20 uploads are accepted' $ok 20
Check 'the 21st upload is refused with 429' (Send "$base/uploads?purpose=PUBLIC_IMAGE" 'POST' $fresh @('file=valid.jpg;type=image/jpeg')).status 429

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"