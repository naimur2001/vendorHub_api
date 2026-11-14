# test-shop-contact.ps1 (shop phone, WhatsApp and validated public links)
# Run from the project root while "npm run dev" is running in another terminal.
# Needs the database container "vendors-hub-db" (one step clears a phone with SQL, see section 7).
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''
$script:lastRaw = ''

function Call($method, $path, $token, $body) {
    $script:lastMsg = ''
    $script:lastRaw = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        $script:lastRaw = $r.Content
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json); raw = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null; raw = '' } }
        $json = $null
        $text = [string]$_.ErrorDetails.Message
        $script:lastRaw = $text
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

function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        exit 1
    }
}

function Keys($obj) { return (@($obj.PSObject.Properties.Name) | Sort-Object) -join ',' }
function Sql($q) { return (($q | docker exec -i vendors-hub-db psql -U vendors -d vendors_hub -t -A) -join '').Trim() }
# PATCH only the links of the test shop and return the status
function Links($links) { return (Call 'PATCH' "/shops/$shopId" $own @{ socialLinks = $links }).status }

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$admin = Login 'admin@vendorshub.test'
$cust = Login 'customer@vendorshub.test'
$staff = Login 'owner2@vendorshub.test'   # staff at TechZone (seed), owner of another shop
$owner3 = Login 'owner3@vendorshub.test'
$seedCustomerPhone = '01700000000'        # the personal phone of the seeded customer

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$digits = Get-Date -Format 'ddHHmmss'
$userPhone = "015$digits"   # the owner's PERSONAL phone: must never be public
$shopPhone = "016$digits"   # the shop's public phone
$newPhone = "019$digits"
$linkKeys = 'facebook,instagram,tiktok,website,youtube'

$reg = Call 'POST' '/auth/register' $null @{ name = 'Contact Owner'; email = "contact$stamp@vendorshub.test"; phone = $userPhone; password = 'Password123!'; role = 'SHOP_OWNER' }
Need ($reg.status -eq 201) 'registering a shop owner'
$own = $reg.json.data.accessToken
$market = @((Call 'GET' '/markets' $null $null).json.data | Where-Object { $_.slug -eq 'jamuna-future-park' })[0]
Need $market 'finding Jamuna Future Park'
$name = "Contact Test $stamp"
$shopBody = @{ name = $name; addressLine = 'Level 1, Shop 7, Jamuna Future Park, Dhaka'; marketId = $market.id }

# ---- 1. creating a shop needs a valid phone ----
$r = Call 'POST' '/shops' $own $shopBody
Check 'a shop without a phone is rejected' $r.status 400
$r = Call 'POST' '/shops' $own ($shopBody + @{ phone = '12345' })
Check 'a shop with a wrong phone is rejected' $r.status 400
$r = Call 'POST' '/shops' $own ($shopBody + @{ phone = $shopPhone; socialLinks = @{ website = 'http://shop.example.com' } })
Check 'a shop with an http link is rejected' $r.status 400
$r = Call 'POST' '/shops' $own ($shopBody + @{ phone = $shopPhone; whatsapp = $shopPhone; socialLinks = @{ facebook = 'https://www.facebook.com/contact.test'; website = 'https://contact-test.example.com' } })
Check 'a shop with phone, WhatsApp and links is created' $r.status 201
$shopId = $r.json.data.id
$slug = $r.json.data.slug
Need $shopId 'creating the test shop'
Check 'the answer has the phone' $r.json.data.phone $shopPhone
Check 'the answer has the facebook link' $r.json.data.socialLinks.facebook 'https://www.facebook.com/contact.test'
Check 'the website is stored as a normalised link' $r.json.data.socialLinks.website 'https://contact-test.example.com/'
Check 'the links always have the five keys' (Keys $r.json.data.socialLinks) $linkKeys

# ---- 2. a valid save ----
$r = Call 'PATCH' "/shops/$shopId" $own @{ phone = $newPhone; whatsapp = $newPhone; socialLinks = @{ instagram = 'https://www.instagram.com/contact.test/'; youtube = 'https://youtu.be/abc123'; tiktok = 'https://www.tiktok.com/@contact.test' } }
Check 'the owner saves phone, WhatsApp and links' $r.status 200
Check 'the new phone is saved' $r.json.data.phone $newPhone
Check 'the new WhatsApp is saved' $r.json.data.whatsapp $newPhone
Check 'the instagram link is saved' $r.json.data.socialLinks.instagram 'https://www.instagram.com/contact.test/'
Check 'a link that was not sent stays (facebook)' $r.json.data.socialLinks.facebook 'https://www.facebook.com/contact.test'
$r = Call 'PATCH' "/shops/$shopId" $own @{ socialLinks = @{ facebook = $null } }
Check 'null removes one link' $r.status 200
Check 'facebook is gone' ($null -eq $r.json.data.socialLinks.facebook) $true
Check 'the other links stay' $r.json.data.socialLinks.youtube 'https://youtu.be/abc123'
$r = Call 'PATCH' "/shops/$shopId" $own @{ whatsapp = $null }
Check 'WhatsApp can be removed with null' $r.status 200
Check 'WhatsApp is gone' ($null -eq $r.json.data.whatsapp) $true
$r = Call 'PATCH' "/shops/$shopId" $admin @{ whatsapp = $newPhone }
Check 'an admin can edit the contact too' $r.status 200

# ---- 3. what is rejected ----
Check 'the phone cannot be removed (null): 400' (Call 'PATCH' "/shops/$shopId" $own @{ phone = $null }).status 400
Check 'a short phone: 400' (Call 'PATCH' "/shops/$shopId" $own @{ phone = '01712' }).status 400
Check 'a phone with +88: 400' (Call 'PATCH' "/shops/$shopId" $own @{ phone = '+8801712345678' }).status 400
Check 'a phone that does not start with 01: 400' (Call 'PATCH' "/shops/$shopId" $own @{ phone = '02712345678' }).status 400
Check 'a wrong WhatsApp number: 400' (Call 'PATCH' "/shops/$shopId" $own @{ whatsapp = 'call-me' }).status 400
Check 'an http:// link: 400' (Links @{ website = 'http://contact-test.example.com' }) 400
Check 'an http:// facebook link: 400' (Links @{ facebook = 'http://www.facebook.com/contact.test' }) 400
Check 'a facebook link on another host: 400' (Links @{ facebook = 'https://facebook.com.evil.example/contact.test' }) 400
Check 'the answer does not repeat the link' ($script:lastRaw -like '*evil.example*') $false
Check 'a facebook link that is really instagram: 400' (Links @{ facebook = 'https://www.instagram.com/contact.test' }) 400
Check 'a youtube link on another host: 400' (Links @{ youtube = 'https://evil.example/youtube.com' }) 400
Check 'a javascript: link: 400' (Links @{ website = 'javascript:alert(1)' }) 400
Check 'a data: link: 400' (Links @{ website = 'data:text/html,hello' }) 400
Check 'a link with a user name and password: 400' (Links @{ facebook = 'https://user:pass@facebook.com/contact.test' }) 400
Check 'a localhost website: 400' (Links @{ website = 'https://localhost/admin' }) 400
Check 'a loopback IP website: 400' (Links @{ website = 'https://127.0.0.1/' }) 400
Check 'a private IP website (192.168): 400' (Links @{ website = 'https://192.168.1.10/' }) 400
Check 'a private IP website (10.x): 400' (Links @{ website = 'https://10.0.0.5/' }) 400
Check 'a link-local IP website: 400' (Links @{ website = 'https://169.254.169.254/' }) 400
Check 'an IPv6 loopback website: 400' (Links @{ website = 'https://[::1]/' }) 400
Check 'a .local website: 400' (Links @{ website = 'https://printer.local/' }) 400
Check 'a .internal website: 400' (Links @{ website = 'https://db.internal/' }) 400
Check 'a link longer than 200 characters: 400' (Links @{ website = ('https://contact-test.example.com/' + ('a' * 200)) }) 400
Check 'an unknown socialLinks key: 400' (Links @{ twitter = 'https://twitter.com/contact.test' }) 400
Check 'a good and a bad link together: 400' (Links @{ tiktok = 'https://www.tiktok.com/@ok'; website = 'https://localhost' }) 400
$s = Call 'GET' "/shops/$slug" $null $null
Check 'after all the rejected saves the phone is unchanged' $s.json.data.phone $newPhone
Check 'and the links are unchanged' $s.json.data.socialLinks.tiktok 'https://www.tiktok.com/@contact.test'
Check 'and no website was replaced' $s.json.data.socialLinks.website 'https://contact-test.example.com/'

# ---- 4. who may edit ----
$tech = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data
Need $tech.id 'finding TechZone'
Check 'staff cannot edit the shop contact: 403' (Call 'PATCH' "/shops/$($tech.id)" $staff @{ phone = '01712345678' }).status 403
Check 'staff cannot edit the links: 403' (Call 'PATCH' "/shops/$($tech.id)" $staff @{ socialLinks = @{ website = 'https://staff.example.com' } }).status 403
Check 'another shop owner cannot: 403' (Call 'PATCH' "/shops/$($tech.id)" $owner3 @{ phone = '01712345678' }).status 403
Check 'a customer cannot: 403' (Call 'PATCH' "/shops/$shopId" $cust @{ phone = '01712345678' }).status 403
Check 'without a login: 401' (Call 'PATCH' "/shops/$shopId" $null @{ phone = '01712345678' }).status 401
Check 'the TechZone phone is unchanged' (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.phone $tech.phone

# ---- 5. the public answers show the shop contact, never a personal phone ----
$s = Call 'GET' "/shops/$slug" $null $null
Check 'the storefront is public' $s.status 200
Check 'the storefront shows the phone' $s.json.data.phone $newPhone
Check 'the storefront shows WhatsApp' $s.json.data.whatsapp $newPhone
Check 'the storefront shows the links' $s.json.data.socialLinks.instagram 'https://www.instagram.com/contact.test/'
Check 'the storefront links have the five keys' (Keys $s.json.data.socialLinks) $linkKeys
Check 'the storefront has no owner fields' (@($s.json.data.PSObject.Properties.Name | Where-Object { $_ -like 'owner*' }).Count) 0
$q = [uri]::EscapeDataString($name)
$list = Call 'GET' "/shops?q=$q" $null $null
$card = @($list.json.data | Where-Object { $_.id -eq $shopId })[0]
Check 'the shop search finds the shop' ($null -ne $card) $true
Check 'the search card shows the phone' $card.phone $newPhone
Check 'the search card shows WhatsApp' $card.whatsapp $newPhone
Check 'the search card shows the links' $card.socialLinks.youtube 'https://youtu.be/abc123'
Check 'the search card links have the five keys' (Keys $card.socialLinks) $linkKeys
$seedCard = @((Call 'GET' '/shops?q=TechZone' $null $null).json.data | Where-Object { $_.slug -eq 'techzone-electronics' })[0]
Check 'a seeded shop has a phone in the search' ($seedCard.phone -match '^01\d{9}$') $true

$marketPage = Call 'GET' "/markets/$($market.slug)" $null $null
$productPage = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$reviews = Call 'GET' '/shops/techzone-electronics/reviews?limit=50' $null $null
Need (($marketPage.status -eq 200) -and ($productPage.status -eq 200) -and ($reviews.status -eq 200)) 'reading the public pages'
$public = @{ storefront = $s.raw; search = $list.raw; market = $marketPage.raw; product = $productPage.raw; reviews = $reviews.raw }
foreach ($page in @('storefront', 'search', 'market', 'product', 'reviews')) {
    Check "the public $page answer has no owner phone" ($public[$page] -like "*$userPhone*") $false
    Check "the public $page answer has no customer phone" ($public[$page] -like "*$seedCustomerPhone*") $false
}

# ---- 6. the customer sees the shop phone on the order ----
$creg = Call 'POST' '/auth/register' $null @{ name = 'Contact Customer'; email = "contactc$stamp@vendorshub.test"; password = 'Password123!' }
Need ($creg.status -eq 201) 'registering a customer'
$buyer = $creg.json.data.accessToken
$sel = @((Call 'GET' '/products/galaxy-a55-5g-8-128gb/listings' $null $null).json.data | Where-Object { $_.shop.supportsPickup -and $_.availability -ne 'OUT_OF_STOCK' })[0]
Need $sel 'finding a listing that can be picked up'
$sellerPhone = (Call 'GET' "/shops/$($sel.shop.slug)" $null $null).json.data.phone
Need $sellerPhone 'reading the phone of the selling shop'
Need ((Call 'POST' '/cart/items' $buyer @{ listingId = $sel.id; quantity = 1 }).status -lt 300) 'adding to the cart'
$co = Call 'POST' '/checkout' $buyer @{ shops = @(@{ shopId = $sel.shop.id; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'PAY_AT_STORE' }) }
Need ($co.status -eq 201) 'the checkout'
$orderId = $co.json.data.orders[0].id
Check 'the checkout answer shows the shop phone' $co.json.data.orders[0].shop.phone $sellerPhone
$o = Call 'GET' "/orders/$orderId" $buyer $null
Check 'the order detail works' $o.status 200
Check 'the order detail shows shop.phone' $o.json.data.shop.phone $sellerPhone
$mine = @((Call 'GET' '/orders' $buyer $null).json.data | Where-Object { $_.id -eq $orderId })[0]
Check 'the order list shows shop.phone' $mine.shop.phone $sellerPhone
Check 'another customer cannot open the order: 404' (Call 'GET' "/orders/$orderId" $cust $null).status 404
Call 'POST' "/orders/$orderId/cancel" $buyer @{ reason = 'Shop contact test cleanup' } | Out-Null

# ---- 7. no phone, no verification request ----
# The API cannot make a shop without a phone any more (required on create, never null on update).
# Shops created before this feature have NULL in the database, so the test makes that state with SQL.
$docs = @(@{ type = 'TRADE_LICENSE'; fileUrl = 'https://example.com/docs/trade-license.pdf' }, @{ type = 'NID'; fileUrl = 'https://example.com/docs/nid.jpg' })
Sql "UPDATE `"Shop`" SET phone = NULL WHERE id = '$shopId';" | Out-Null
Check 'the phone is gone in the database' (Sql "SELECT count(*) FROM `"Shop`" WHERE id = '$shopId' AND phone IS NULL;") '1'
Check 'the storefront of an old shop shows phone null' ($null -eq (Call 'GET' "/shops/$slug" $null $null).json.data.phone) $true
$r = Call 'POST' "/shops/$shopId/verifications" $own @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = $docs }
Check 'a verification request without a shop phone: 409' $r.status 409
Check 'with the message to add the phone' $script:lastMsg 'Add your shop phone first'
Check 'the owner adds the phone again' (Call 'PATCH' "/shops/$shopId" $own @{ phone = $newPhone }).status 200
$r = Call 'POST' "/shops/$shopId/verifications" $own @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = $docs }
Check 'with a phone the request is created' $r.status 201
$vId = $r.json.data.id
Need $vId 'the verification request'

$detail = Call 'GET' "/admin/verifications/$vId" $admin $null
$nidDoc = @($detail.json.data.documents | Where-Object { $_.type -eq 'NID' })[0]
Check 'the admin view of the request has no phone' ($detail.raw -like "*$newPhone*") $false
$r = Call 'POST' "/admin/verifications/$vId/request-correction" $admin @{ note = 'The NID photo is blurry, please upload a clear copy.'; documentIds = @($nidDoc.id) }
Check 'the admin asks for a correction' $r.status 200
Sql "UPDATE `"Shop`" SET phone = NULL WHERE id = '$shopId';" | Out-Null
$nid2 = @(@{ type = 'NID'; fileUrl = 'https://example.com/docs/nid-clear.jpg' })
$r = Call 'POST' "/verifications/$vId/resubmit" $own @{ documents = $nid2 }
Check 'a resubmit without a shop phone: 409' $r.status 409
Check 'with the same message' $script:lastMsg 'Add your shop phone first'
Check 'the owner adds the phone again (2)' (Call 'PATCH' "/shops/$shopId" $own @{ phone = $newPhone }).status 200
$r = Call 'POST' "/verifications/$vId/resubmit" $own @{ documents = $nid2 }
Check 'with a phone the resubmit works' $r.status 200

# ---- 8. the audit log: field names only, never the values ----
$a = Call 'GET' "/admin/audit-logs?entityType=Shop&entityId=$shopId&limit=50" $admin $null
Check 'the audit log works' $a.status 200
$contact = @($a.json.data | Where-Object { $_.action -eq 'shop.contact_updated' })
Check 'contact changes are recorded' ($contact.Count -ge 5) $true
$first = $contact[$contact.Count - 1]   # the oldest one: phone + WhatsApp + links in one save
Check 'the entry has only the field names' (Keys $first.meta) 'fields'
Check 'the first entry names phone, WhatsApp and the links' ((@($first.meta.fields) | Sort-Object) -join ',') 'phone,socialLinks,whatsapp'
Check 'the entry names the actor' ([bool]$first.actor.id) $true
Check 'the audit log has no phone number' (($a.raw -like "*$newPhone*") -or ($a.raw -like "*$shopPhone*")) $false
Check 'the audit log has no link' (($a.raw -like '*instagram.com*') -or ($a.raw -like '*youtu.be*') -or ($a.raw -like '*example.com*')) $false
$before = $contact.Count
Call 'PATCH' "/shops/$shopId" $own @{ phone = $newPhone } | Out-Null
Call 'PATCH' "/shops/$shopId" $own @{ description = 'Only the description changes.' } | Out-Null
$a2 = Call 'GET' "/admin/audit-logs?entityType=Shop&entityId=$shopId&limit=50" $admin $null
Check 'saving the same phone or another field adds no contact entry' (@($a2.json.data | Where-Object { $_.action -eq 'shop.contact_updated' }).Count) $before
Check 'a shop owner cannot read the audit log: 403' (Call 'GET' "/admin/audit-logs?entityType=Shop&entityId=$shopId" $own $null).status 403

# ---- 9. the rule table (every spelling of a private address, look-alike hosts, ...) ----
$out = & node scripts/check-social-links.mjs 2>&1
Check 'the link rule table passes' $LASTEXITCODE 0
if ($LASTEXITCODE -ne 0) { Write-Host ($out | Out-String) -ForegroundColor Red }

# ---- cleanup: close the request, take the test shop out of the public list ----
Call 'POST' "/admin/verifications/$vId/reject" $admin @{ reason = 'Test shop, closing the request.' } | Out-Null
Call 'PATCH' "/admin/shops/$shopId/status" $admin @{ isActive = $false; reason = 'Shop contact test cleanup.' } | Out-Null
Check 'after cleanup the test shop is not public' (Call 'GET' "/shops/$slug" $null $null).status 404

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
