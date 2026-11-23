# test-to-let.ps1 (Shop To-Let with the admin as middleman; birth year and gender)
# Run from the project root while "npm run dev" is running in another terminal (mock modes, MAIL_MODE=log).
# Everything it makes is deleted again at the end (scripts/to-let-test-helper.mjs cleanup).
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''

function Call($method, $path, $token, $body, $headers) {
    $script:lastMsg = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    $h = @{}
    if ($token) { $h.Authorization = "Bearer $token" }
    if ($headers) { foreach ($k in $headers.Keys) { $h[$k] = $headers[$k] } }
    if ($h.Count) { $params.Headers = $h }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        $json = $null
        if ($r.Content) { $json = $r.Content | ConvertFrom-Json }
        return @{ status = [int]$r.StatusCode; json = $json; raw = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null; raw = '' } }
        $text = $_.ErrorDetails.Message
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
        return @{ status = [int]$resp.StatusCode; json = $json; raw = $text }
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

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$rnd = [guid]::NewGuid().ToString('N').Substring(0, 8)
$suffix = "-$rnd@vendorshub.test"
$script:users = @()
$admin = Login 'admin@vendorshub.test'
$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$tmp = Join-Path $env:TEMP 'vh-to-let'
New-Item -ItemType Directory -Force $tmp | Out-Null
node scripts/make-banner-fixtures.mjs $tmp | Out-Null   # banner.png, small.png, fake.png
[IO.File]::WriteAllText((Join-Path $tmp 'proof.pdf'), "%PDF-1.4`n1 0 obj << >> endobj`ntrailer << >>`n%%EOF`n")
[IO.File]::WriteAllText((Join-Path $tmp 'notes.txt'), 'just text')

function Cleanup {
    $out = node --env-file=.env scripts/to-let-test-helper.mjs cleanup $since $suffix @($script:users) | Select-Object -Last 1 | ConvertFrom-Json
    Write-Host "INFO  cleanup: $($out.listings) listings, $($out.users) users, $($out.notifications) notifications, $($out.files) files removed"
    return $out
}
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        Cleanup | Out-Null
        exit 1
    }
}
function Phone { return '017' + (Get-Random -Minimum 10000000 -Maximum 99999999) }
function MailToken($email, $subjectLike) {
    $mail = @(Get-Content 'logs\outbox.jsonl' | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.to -eq $email -and $_.subject -like $subjectLike }) | Select-Object -Last 1
    if (-not $mail) { return $null }
    if ($mail.text -match 'token=([a-f0-9]{64})') { return $Matches[1] }
    return $null
}
function Upload($path, $field, $file, $type, $headers) {
    $out = Join-Path $tmp 'resp.json'
    if (Test-Path $out) { Remove-Item $out }
    $cargs = @('-s', '-o', $out, '-w', '%{http_code}', '-X', 'POST')
    foreach ($k in $headers.Keys) { $cargs += @('-H', "${k}: $($headers[$k])") }
    $cargs += @('-F', "$field=@$(Join-Path $tmp $file);type=$type")
    $code = & curl.exe @cargs "$base$path"
    $json = $null
    if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    return @{ status = [int]$code; json = $json }
}
function Listing($extra) {
    $b = @{
        marketName = 'Test Market'; levelFloor = 'Level 3'; shopNumber = '3-12'; addressLine = 'House 1, Road 2, Test Area, Dhaka'
        sizeSqft = 150; monthlyRent = 25000; advance = 100000; availableFrom = '2026-12-01'
        description = 'A corner shop near the escalator, good light, ready to use.'
    }
    foreach ($k in $extra.Keys) { $b[$k] = $extra[$k] }
    return $b
}

$markets = @((Call 'GET' '/markets?limit=5' $null $null).json.data)
$marketId = $markets[0].id
$cats = @((Call 'GET' '/categories' $null $null).json.data)

# ---- 1. a guest listing: email confirmation, manage token ----
$gEmail = "guest$suffix"; $gPhone = Phone
Check 'guest without contact -> 400' (Call 'POST' '/to-let' $null (Listing @{})).status 400
Check 'unknown field -> 400' (Call 'POST' '/to-let' $null (Listing @{ contactName = 'Rahim'; contactPhone = $gPhone; contactEmail = $gEmail; status = 'PUBLISHED' })).status 400
Check 'bad phone -> 400' (Call 'POST' '/to-let' $null (Listing @{ contactName = 'Rahim'; contactPhone = '12345'; contactEmail = $gEmail })).status 400
Check 'no market at all -> 400' (Call 'POST' '/to-let' $null (Listing @{ marketName = $null; contactName = 'Rahim'; contactPhone = $gPhone; contactEmail = $gEmail })).status 400
$g = Call 'POST' '/to-let' $null (Listing @{ contactName = 'Rahim Guest'; contactPhone = $gPhone; contactEmail = $gEmail; marketId = $marketId; marketName = $null; suitableFor = @($cats[0].id) })
Check 'guest listing -> 201' $g.status 201
Need ($g.status -eq 201) 'the guest listing'
$gid = $g.json.data.id
Check 'guest: PENDING_EMAIL' $g.json.data.status 'PENDING_EMAIL'
Check 'guest: confirmation required' $g.json.data.emailConfirmationRequired $true
Check 'no manage token in the answer' ($g.raw -like '*manageToken*') $false
Check 'not on the owner routes without the token -> 404' (Call 'GET' "/to-let/$gid/messages" $null $null).status 404
$ct = MailToken $gEmail '*Confirm your Shop To-Let*'
Check 'the confirmation email is in the outbox' ([bool]$ct) $true
Check 'a wrong token -> 400' (Call 'POST' '/to-let/confirm-email' $null @{ token = ('a' * 64) }).status 400
$cf = Call 'POST' '/to-let/confirm-email' $null @{ token = $ct }
Check 'confirm -> SUBMITTED' "$($cf.status)/$($cf.json.data.status)" '200/SUBMITTED'
Check 'the link works once' (Call 'POST' '/to-let/confirm-email' $null @{ token = $ct }).status 400
$mt = MailToken $gEmail '*private link*'
Check 'the manage link was emailed' ([bool]$mt) $true
$mh = @{ 'X-Manage-Token' = $mt }
$m = Call 'GET' "/to-let/manage?token=$mt" $null $null
Check 'manage view -> 200' "$($m.status)/$($m.json.data.status)" '200/SUBMITTED'
Check 'the owner sees their own contact' $m.json.data.contactPhone $gPhone
Check 'a wrong manage token -> 404' (Call 'GET' "/to-let/manage?token=$('b' * 64)" $null $null).status 404
Check 'suitableFor names' (@($m.json.data.suitableFor)[0].id) $cats[0].id

# ---- 2. a logged-in user with a verified email: straight to SUBMITTED ----
$uEmail = "owner$suffix"
$reg = Call 'POST' '/auth/register' $null @{ name = 'To-Let Owner'; email = $uEmail; password = 'Password123!' }
Need ($reg.status -eq 201) 'registering a test owner'
$script:users += $reg.json.data.user.id
$ut = $reg.json.data.accessToken
$uPhone = Phone
$u = Call 'POST' '/to-let' $ut (Listing @{ contactPhone = $uPhone; monthlyRent = 40000; sizeSqft = 300; description = 'Big shop with a storage room at the back, electricity ready.' })
Check 'verified user -> SUBMITTED at once' "$($u.status)/$($u.json.data.status)/$($u.json.data.emailConfirmationRequired)" '201/SUBMITTED/False'
$uid = $u.json.data.id
Check 'the profile fills the contact name and email' "$($u.json.data.contactName)/$($u.json.data.contactEmail)" "To-Let Owner/$uEmail"
Check 'GET /me/to-let lists it' (@((Call 'GET' '/me/to-let' $ut $null).json.data | Where-Object { $_.id -eq $uid }).Count) 1
Check 'another user cannot edit it -> 404' (Call 'PATCH' "/to-let/$uid" $cust @{ monthlyRent = 1 }).status 404
Check 'admins were told about it' ([bool](@((Call 'GET' '/notifications?limit=50' $admin $null).json.data | Where-Object { $_.type -eq 'TOLET_SUBMITTED' -and $_.data.toLetId -eq $uid }).Count)) $true

# ---- 3. at most 3 open listings per phone or email ----
$lEmail = "limit$suffix"; $lPhone = Phone
foreach ($i in 1..3) { Call 'POST' '/to-let' $null (Listing @{ contactName = 'Limit Test'; contactPhone = $lPhone; contactEmail = "limit$i$suffix" }) | Out-Null }
$l4 = Call 'POST' '/to-let' $null (Listing @{ contactName = 'Limit Test'; contactPhone = $lPhone; contactEmail = $lEmail })
Check '4th open listing on one phone -> 409 TOLET_LIMIT' "$($l4.status)/$($l4.json.error.details.code)" '409/TOLET_LIMIT'
$l5 = Call 'POST' '/to-let' $null (Listing @{ contactName = 'Limit Test'; contactPhone = (Phone); contactEmail = 'limit1' + $suffix })
Check 'the same email on another phone also counts (1 of 3 -> ok)' $l5.status 201

# ---- 4. photos and documents ----
$p1 = Upload "/to-let/$gid/photos" 'image' 'banner.png' 'image/png' $mh
Check 'guest photo with the manage token -> 201' $p1.status 201
Check 'photo is WebP' ($p1.json.data.url -like '*.webp') $true
Check 'photo without a token -> 404' (Upload "/to-let/$gid/photos" 'image' 'banner.png' 'image/png' @{}).status 404
Check 'a text file as photo -> 400' (Upload "/to-let/$gid/photos" 'image' 'fake.png' 'image/png' $mh).status 400
foreach ($i in 2..6) { Upload "/to-let/$gid/photos" 'image' 'banner.png' 'image/png' $mh | Out-Null }
$p7 = Upload "/to-let/$gid/photos" 'image' 'banner.png' 'image/png' $mh
Check '7th photo -> 409 TOLET_PHOTO_LIMIT' "$($p7.status)/$($p7.json.error.details.code)" '409/TOLET_PHOTO_LIMIT'
$d1 = Upload "/to-let/$gid/documents" 'file' 'proof.pdf' 'application/pdf' $mh
Check 'ownership document (PDF) -> 201' $d1.status 201
Check 'a text file as document -> 400' (Upload "/to-let/$gid/documents" 'file' 'notes.txt' 'text/plain' $mh).status 400
Upload "/to-let/$gid/documents" 'file' 'banner.png' 'image/png' $mh | Out-Null
Upload "/to-let/$gid/documents" 'file' 'proof.pdf' 'application/pdf' $mh | Out-Null
Check '4th document -> 409' (Upload "/to-let/$gid/documents" 'file' 'proof.pdf' 'application/pdf' $mh).status 409
$del = Call 'DELETE' "/to-let/$gid/photos/$($p1.json.data.id)" $null $null $mh
Check 'remove a photo -> 204' $del.status 204

# ---- 5. admin review and publish ----
Check 'customer cannot open the admin list -> 403' (Call 'GET' '/admin/to-let' $cust $null).status 403
$al = Call 'GET' '/admin/to-let?status=SUBMITTED&limit=100' $admin $null
Check 'admin list -> 200' $al.status 200
Check 'counts per status' ((@($al.json.meta.counts.PSObject.Properties.Name) | Sort-Object) -join ',') 'EXPIRED,NEEDS_INFO,PENDING_EMAIL,PUBLISHED,REJECTED,RENTED,SUBMITTED,WITHDRAWN'
Check 'the guest listing is in the SUBMITTED queue' (@($al.json.data | Where-Object { $_.id -eq $gid }).Count) 1
$ad = Call 'GET' "/admin/to-let/$gid" $admin $null
Check 'admin detail has the private contact' $ad.json.data.contactPhone $gPhone
Check 'admin detail has 3 documents with links' @($ad.json.data.documents | Where-Object { $_.url }).Count 3
$docUrl = "/admin/to-let/$gid/documents/$(@($ad.json.data.documents)[0].id)"
Check 'admin downloads a document' (Call 'GET' $docUrl $admin $null).status 200
Check 'a customer cannot -> 403' (Call 'GET' $docUrl $cust $null).status 403
Check 'not public before publishing' (@((Call 'GET' '/to-let?limit=50' $null $null).json.data | Where-Object { $_.id -eq $gid }).Count) 0
$pub = Call 'POST' "/admin/to-let/$gid/publish" $admin $null
Check 'publish -> PUBLISHED' "$($pub.status)/$($pub.json.data.status)" '200/PUBLISHED'
$slug = $pub.json.data.slug
Check 'it got a slug' ([bool]$slug) $true
$days = ([datetime]$pub.json.data.expiresAt - [datetime]$pub.json.data.publishedAt).TotalDays
Check 'it expires 60 days after publishing' ([math]::Round($days)) 60
Check 'publish twice -> 409' (Call 'POST' "/admin/to-let/$gid/publish" $admin $null).status 409
Check 'the guest got the "live" email' ([bool](@(Get-Content 'logs\outbox.jsonl' | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.to -eq $gEmail -and $_.subject -like '*live*' }).Count)) $true
$log = @((Call 'GET' '/admin/message-log?limit=50' $admin $null).json.data | Where-Object { $_.template -eq 'TOLET_PUBLISHED' })
Check 'an SMS went out (masked in the log)' ($log.Count -ge 1 -and $log[0].toMasked -like '017*' -and $log[0].toMasked -like '*`**') $true
Check 'publish the logged-in one too' (Call 'POST' "/admin/to-let/$uid/publish" $admin $null).json.data.status 'PUBLISHED'
Check 'the logged-in owner got an in-app note' ([bool](@((Call 'GET' '/notifications' $ut $null).json.data | Where-Object { $_.type -eq 'TOLET_PUBLISHED' }).Count)) $true

# ---- 6. public list and detail: no contact, no documents ----
$pl = Call 'GET' '/to-let?limit=50' $null $null
$mineIds = @($pl.json.data | Where-Object { $_.id -eq $gid -or $_.id -eq $uid })
Check 'both are public' $mineIds.Count 2
Check 'public list leaks no phone' ($pl.raw -like "*$gPhone*") $false
Check 'public list leaks no email' ($pl.raw -like "*$suffix*") $false
Check 'public card fields' ((@($mineIds[0].PSObject.Properties.Name) | Sort-Object) -join ',') 'addressLine,advance,availableFrom,cover,expiresAt,id,levelFloor,market,marketName,monthlyRent,photoCount,publishedAt,sizeSqft,slug,title'
$pd = Call 'GET' "/to-let/$slug" $null $null
Check 'public detail -> 200' $pd.status 200
Check 'public detail leaks no contact or documents' (($pd.raw -like "*$gPhone*") -or ($pd.raw -like "*$suffix*") -or ($pd.raw -like '*documents*') -or ($pd.raw -like '*contact*')) $false
Check 'public detail has 5 photos' @($pd.json.data.photos).Count 5
Check 'filter by rent' (@((Call 'GET' '/to-let?minRent=30000&limit=50' $null $null).json.data | Where-Object { $_.id -eq $gid -or $_.id -eq $uid }) | ForEach-Object { $_.id }) $uid
Check 'filter by size' (@((Call 'GET' '/to-let?maxSize=200&limit=50' $null $null).json.data | Where-Object { $_.id -eq $gid -or $_.id -eq $uid }) | ForEach-Object { $_.id }) $gid
Check 'filter by market' (@((Call 'GET' "/to-let?marketId=$marketId&limit=50" $null $null).json.data | Where-Object { $_.id -eq $gid }).Count) 1
Check 'search q' (@((Call 'GET' '/to-let?q=escalator&limit=50' $null $null).json.data | Where-Object { $_.id -eq $gid }).Count) 1
$asc = @((Call 'GET' '/to-let?sort=rent_asc&limit=50' $null $null).json.data | ForEach-Object { $_.monthlyRent })
$sorted = $true; for ($i = 1; $i -lt $asc.Count; $i++) { if ($asc[$i] -lt $asc[$i - 1]) { $sorted = $false } }
Check 'sort rent_asc' $sorted $true
Check 'minRent above maxRent -> 400' (Call 'GET' '/to-let?minRent=5&maxRent=1' $null $null).status 400
Check 'unknown slug -> 404' (Call 'GET' '/to-let/no-such-shop' $null $null).status 404

# ---- 7. editing a published listing sends it back to review ----
$e = Call 'PATCH' "/to-let/$uid" $ut @{ monthlyRent = 42000 }
Check 'edit -> back to SUBMITTED' "$($e.status)/$($e.json.data.status)" '200/SUBMITTED'
Check 'it left the public list' (@((Call 'GET' '/to-let?limit=50' $null $null).json.data | Where-Object { $_.id -eq $uid }).Count) 0
Check 'contactEmail cannot be edited -> 400' (Call 'PATCH' "/to-let/$uid" $ut @{ contactEmail = "x$suffix" }).status 400

# ---- 8. request info, the owner thread ----
$ri = Call 'POST' "/admin/to-let/$uid/request-info" $admin @{ message = 'Please add a photo of the front.' }
Check 'request info -> NEEDS_INFO' $ri.json.data.status 'NEEDS_INFO'
$ot = Call 'GET' "/to-let/$uid/messages" $ut $null
Check 'the owner sees the admin message' (@($ot.json.data.messages)[0].body) 'Please add a photo of the front.'
Check 'owner replies' (Call 'POST' "/to-let/$uid/messages" $ut @{ body = 'Added, thanks.' }).status 201
Check 'empty message -> 400' (Call 'POST' "/to-let/$uid/messages" $ut @{ body = ' ' }).status 400
Check 'over 1000 characters -> 400' (Call 'POST' "/to-let/$uid/messages" $ut @{ body = ('x' * 1001) }).status 400
Check 'admin replies in the owner thread' (Call 'POST' "/admin/to-let/$uid/messages" $admin @{ body = 'Looks good now.' }).status 201
Check 'admin detail shows the owner thread' @((Call 'GET' "/admin/to-let/$uid" $admin $null).json.data.ownerThread.messages).Count 3
Check 'publish from NEEDS_INFO' (Call 'POST' "/admin/to-let/$uid/publish" $admin $null).json.data.status 'PUBLISHED'

# ---- 9. enquiries ----
$rPhone = Phone
$iq = Call 'POST' "/to-let/$gid/inquiries" $null @{ name = 'Karim Renter'; phone = $rPhone; message = 'Is the shop still free from December?' }
Check 'guest enquiry -> 201' $iq.status 201
$iid = $iq.json.data.inquiryId; $ft = $iq.json.data.followToken
Check 'guest gets a follow token' ($ft -match '^[a-f0-9]{64}$') $true
Check 'same phone, same listing -> 409 INQUIRY_EXISTS' (Call 'POST' "/to-let/$gid/inquiries" $null @{ name = 'Karim'; phone = $rPhone; message = 'Hello again, me again.' }).json.error.details.code 'INQUIRY_EXISTS'
Check 'missing phone -> 400' (Call 'POST' "/to-let/$gid/inquiries" $null @{ name = 'Karim'; message = 'Hello there friend' }).status 400
Check 'enquiry on an unpublished listing -> 404' (Call 'POST' "/to-let/$($l5.json.data.id)/inquiries" $null @{ name = 'Karim'; phone = (Phone); message = 'Is it free now?' }).status 404
$ci = Call 'POST' "/to-let/$gid/inquiries" $cust @{ name = 'Test Customer'; phone = (Phone); message = 'I would like to see it.' }
Check 'logged-in enquiry: no follow token' "$($ci.status)/$([bool]$ci.json.data.followToken)" '201/False'
Check 'admins were told about the enquiry' ([bool](@((Call 'GET' '/notifications?limit=50' $admin $null).json.data | Where-Object { $_.type -eq 'TOLET_INQUIRY' -and $_.data.toLetInquiryId -eq $iid }).Count)) $true
$im = Call 'GET' "/to-let/inquiries/$iid/messages?token=$ft" $null $null
Check 'guest reads the enquiry thread' "$($im.status)/$(@($im.json.data.messages).Count)" '200/1'
Check 'without the token -> 404' (Call 'GET' "/to-let/inquiries/$iid/messages" $null $null).status 404
Check 'with the header token' (Call 'GET' "/to-let/inquiries/$iid/messages" $null $null @{ 'X-Follow-Token' = $ft }).status 200
Check 'another user -> 404' (Call 'GET' "/to-let/inquiries/$iid/messages" $owner $null).status 404
Check 'the customer reads their own' (Call 'GET' "/to-let/inquiries/$($ci.json.data.inquiryId)/messages" $cust $null).status 200
Check 'admin replies to the enquirer' (Call 'POST' "/admin/to-let/inquiries/$iid/messages" $admin @{ body = 'Yes, it is free. When can you visit?' }).status 201
Check 'guest replies' (Call 'POST' "/to-let/inquiries/$iid/messages?token=$ft" $null @{ body = 'Saturday morning works.' }).status 201
$im2 = Call 'GET' "/to-let/inquiries/$iid/messages?token=$ft" $null $null
Check 'first admin answer moves it to IN_TALKS' $im2.json.data.status 'IN_TALKS'
Check 'the renter never sees the owner contact' (($im2.raw -like "*$gPhone*") -or ($im2.raw -like "*$gEmail*")) $false
Check 'the owner never sees the renter contact' ((Call 'GET' "/to-let/$gid/messages" $null $null $mh).raw -like "*$rPhone*") $false
$adi = @((Call 'GET' "/admin/to-let/$gid" $admin $null).json.data.inquiries | Where-Object { $_.id -eq $iid })[0]
Check 'admin sees the enquiry contact and thread' "$($adi.phone)/$(@($adi.messages).Count)" "$rPhone/3"

# 3 enquiries per phone per day
$dPhone = Phone
Call 'POST' "/to-let/$gid/inquiries" $null @{ name = 'Daily'; phone = $dPhone; message = 'First question here' } | Out-Null
Call 'POST' "/to-let/$uid/inquiries" $null @{ name = 'Daily'; phone = $dPhone; message = 'Second question here' } | Out-Null
$first = @((Call 'GET' "/admin/to-let/$gid" $admin $null).json.data.inquiries | Where-Object { $_.phone -eq $dPhone })[0]
Call 'PATCH' "/admin/to-let/inquiries/$($first.id)" $admin @{ status = 'CLOSED' } | Out-Null
Call 'POST' "/to-let/$gid/inquiries" $null @{ name = 'Daily'; phone = $dPhone; message = 'Third question here' } | Out-Null
Call 'PATCH' "/admin/to-let/inquiries/$($first.id)" $admin @{ status = 'CLOSED' } | Out-Null
$q4 = Call 'POST' "/to-let/$uid/inquiries" $null @{ name = 'Daily'; phone = $dPhone; message = 'Fourth question here' }
Check '4th enquiry of the day -> 429 INQUIRY_LIMIT' "$($q4.status)/$($q4.json.error.details.code)" '429/INQUIRY_LIMIT'
Check 'bad enquiry status -> 400' (Call 'PATCH' "/admin/to-let/inquiries/$iid" $admin @{ status = 'DONE' }).status 400

# ---- 10. share contacts (only on the admin's click) ----
Check 'customer cannot share -> 403' (Call 'POST' "/admin/to-let/inquiries/$iid/share-contacts" $cust $null).status 403
$sc = Call 'POST' "/admin/to-let/inquiries/$iid/share-contacts" $admin $null
Check 'share -> CONNECTED' "$($sc.status)/$($sc.json.data.status)" '200/CONNECTED'
$shared = @((Call 'GET' '/admin/message-log?limit=50' $admin $null).json.data | Where-Object { $_.template -eq 'TOLET_CONTACT_SHARED' })
Check 'two contact messages went out' ($shared.Count -ge 2) $true
Check 'the log never keeps a full number' (@($shared | Where-Object { $_.body -like "*$gPhone*" -or $_.body -like "*$rPhone*" }).Count) 0

# ---- 11. notes, reject, rented, renew ----
$nt = Call 'POST' "/admin/to-let/$gid/notes" $admin @{ body = 'Called the owner, documents look fine.' }
Check 'admin note -> 201' $nt.status 201
Check '501 characters -> 400' (Call 'POST' "/admin/to-let/$gid/notes" $admin @{ body = ('n' * 501) }).status 400
Check 'notes in the detail' @((Call 'GET' "/admin/to-let/$gid" $admin $null).json.data.notes).Count 1
Check 'the owner view has no notes' ((Call 'GET' "/to-let/manage?token=$mt" $null $null).raw -like '*Called the owner*') $false
$rj = Call 'POST' "/admin/to-let/$($l5.json.data.id)/reject" $admin @{ reason = 'Not a real shop address.' }
Check 'reject -> REJECTED with the reason' "$($rj.json.data.status)/$($rj.json.data.rejectReason)" 'REJECTED/Not a real shop address.'
Check 'reject without a reason -> 400' (Call 'POST' "/admin/to-let/$gid/reject" $admin @{}).status 400
Check 'a rejected listing cannot be published -> 409' (Call 'POST' "/admin/to-let/$($l5.json.data.id)/publish" $admin $null).status 409

# ---- 12. the daily job: reminder 5 days before, then expiry ----
$s1 = node --env-file=.env scripts/run-tolet-sweep.mjs --days-ahead=56 | Where-Object { $_ -like '{"reminded"*' } | Select-Object -Last 1 | ConvertFrom-Json
Check 'job 56 days ahead reminds' ($s1.reminded -ge 2) $true
Check 'the guest got the "ends soon" email' ([bool](@(Get-Content 'logs\outbox.jsonl' | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.to -eq $gEmail -and $_.subject -like '*ends soon*' }).Count)) $true
$s2 = node --env-file=.env scripts/run-tolet-sweep.mjs --days-ahead=56 | Where-Object { $_ -like '{"reminded"*' } | Select-Object -Last 1 | ConvertFrom-Json
Check 'only one reminder' $s2.reminded 0
$s3 = node --env-file=.env scripts/run-tolet-sweep.mjs --days-ahead=61 | Where-Object { $_ -like '{"reminded"*' } | Select-Object -Last 1 | ConvertFrom-Json
Check 'job 61 days ahead expires them' ($s3.expired -ge 2) $true
Check 'expired is not public' (Call 'GET' "/to-let/$slug" $null $null).status 404
$rn = Call 'POST' "/admin/to-let/$gid/renew" $admin $null
Check 'renew an expired listing -> PUBLISHED' $rn.json.data.status 'PUBLISHED'
Check 'public again' (Call 'GET' "/to-let/$slug" $null $null).status 200
Check 'mark rented' (Call 'POST' "/admin/to-let/$gid/mark-rented" $admin $null).json.data.status 'RENTED'
Check 'rented is not public' (Call 'GET' "/to-let/$slug" $null $null).status 404
Check 'the enquiries were closed' (@((Call 'GET' "/admin/to-let/$gid" $admin $null).json.data.inquiries | Where-Object { $_.status -ne 'CLOSED' }).Count) 0
Check 'a rented listing cannot be edited -> 409' (Call 'PATCH' "/to-let/$gid" $null @{ monthlyRent = 1 } $mh).status 409

# ---- 13. withdraw ----
Check 'an expired listing cannot be withdrawn -> 409' (Call 'POST' "/to-let/$uid/withdraw" $ut $null).status 409
$w = Call 'POST' '/to-let' $ut (Listing @{ contactPhone = $uPhone })
Check 'withdraw -> WITHDRAWN' (Call 'POST' "/to-let/$($w.json.data.id)/withdraw" $ut $null).json.data.status 'WITHDRAWN'
Check 'withdraw twice -> 409' (Call 'POST' "/to-let/$($w.json.data.id)/withdraw" $ut $null).status 409

# ---- 14. birth year and gender (private) ----
$year = [DateTime]::UtcNow.Year
$young = Call 'POST' '/auth/register' $null @{ name = 'Too Young'; email = "young$suffix"; password = 'Password123!'; birthYear = $year - 10 }
Check 'register under 13 -> 400 TOO_YOUNG' "$($young.status)/$($young.json.error.details.code)" '400/TOO_YOUNG'
Check 'register 101 years old -> 400' (Call 'POST' '/auth/register' $null @{ name = 'Very Old'; email = "old$suffix"; password = 'Password123!'; birthYear = $year - 101 }).status 400
Check 'bad gender -> 400' (Call 'POST' '/auth/register' $null @{ name = 'Bad Gender'; email = "bg$suffix"; password = 'Password123!'; gender = 'X' }).status 400
$dr = Call 'POST' '/auth/register' $null @{ name = 'Demo Person'; email = "demo$suffix"; password = 'Password123!'; birthYear = 1995; gender = 'FEMALE' }
Check 'register with both -> 201' $dr.status 201
$script:users += $dr.json.data.user.id
$dt = $dr.json.data.accessToken
Check 'the session user has both' "$($dr.json.data.user.birthYear)/$($dr.json.data.user.gender)" '1995/FEMALE'
$me = (Call 'GET' '/auth/me' $dt $null).json.data
Check '/auth/me has both' "$($me.birthYear)/$($me.gender)" '1995/FEMALE'
$pp = Call 'PATCH' '/users/me' $dt @{ birthYear = $year - 13; gender = 'PREFER_NOT_TO_SAY' }
Check 'PATCH: exactly 13 is fine' "$($pp.status)/$($pp.json.data.birthYear)/$($pp.json.data.gender)" "200/$($year - 13)/PREFER_NOT_TO_SAY"
$py = Call 'PATCH' '/users/me' $dt @{ birthYear = $year - 12 }
Check 'PATCH: 12 -> 400 TOO_YOUNG' "$($py.status)/$($py.json.error.details.code)" '400/TOO_YOUNG'
Check 'PATCH: a year in the future -> 400' (Call 'PATCH' '/users/me' $dt @{ birthYear = $year + 1 }).status 400
Check 'PATCH: not a number -> 400' (Call 'PATCH' '/users/me' $dt @{ birthYear = 'abc' }).status 400
$pn = Call 'PATCH' '/users/me' $dt @{ birthYear = $null; gender = $null }
Check 'PATCH: null clears both' "$($pn.status)/$($pn.json.data.birthYear)/$($pn.json.data.gender)" '200//'
Call 'PATCH' '/users/me' $dt @{ birthYear = 1990; gender = 'MALE' } | Out-Null
$au = Call 'GET' "/admin/users/$($dr.json.data.user.id)" $admin $null
Check 'admin user detail shows neither' (($au.raw -like '*birthYear*') -or ($au.raw -like '*gender*')) $false
Check 'admin user list shows neither' ((Call 'GET' "/admin/users?q=demo$suffix" $admin $null).raw -like '*birthYear*') $false
$demo = (Call 'GET' '/dashboard/admin' $admin $null).json.data.demographics
Check 'demographics: age groups' ((@($demo.ageGroups.PSObject.Properties.Name) | Sort-Object) -join ',') '18-24,25-34,35-44,45-54,55plus,under18,unknown'
Check 'demographics: gender keys' ((@($demo.gender.PSObject.Properties.Name) | Sort-Object) -join ',') 'FEMALE,MALE,OTHER,PREFER_NOT_TO_SAY,unknown'
$values = @($demo.ageGroups.PSObject.Properties.Value) + @($demo.gender.PSObject.Properties.Value)
Check 'every count is a number of 5+ or "<5"' (@($values | Where-Object { -not (($_ -is [int] -or $_ -is [long]) -and $_ -ge 5) -and $_ -ne '<5' }).Count) 0
Check 'the 35-44 group (1 person) is hidden' $demo.ageGroups.'35-44' '<5'

# ---- 15. cleanup: no test data left ----
$out = Cleanup
Check 'cleanup removed the test listings' ($out.listings -ge 7) $true
Check 'cleanup removed the test users' $out.users 2
Check 'nothing of ours is public' (@((Call 'GET' '/to-let?limit=50' $null $null).json.data | Where-Object { $_.id -eq $gid -or $_.id -eq $uid }).Count) 0

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
