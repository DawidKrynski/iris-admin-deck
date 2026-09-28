"""End-to-end UI tests (Playwright, headless Chromium) against a running instance.

    uvx --with playwright python -m playwright install chromium   # once
    uvx --with playwright python tests/e2e/test_ui.py [base_url]

Uses a throw-away web application named per run and always removes it. Exits non-zero on the first failure.
"""
import json
import os
import secrets
import sys
import urllib.request

from playwright.sync_api import expect, sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:52785").rstrip("/")
UI = f"{BASE}/admindeck/index.html"
APP = f"/zzuitest-{os.getpid()}"
SOURCES = ["messages.log", "alerts.log", "System Monitor", "Journal log", "Application errors", "Audit", "Task Manager"]
SCREENS = ["dashboard", "webapps", "explorer", "users", "roles", "secrets", "tasks", "processes", "system", "languages", "interop", "status", "logs", "audit"]


def api(method, path, body=None):
    """Direct SysAdmin call (basic auth) used to prepare and clean up test data."""
    req = urllib.request.Request(f"{BASE}/api/admin{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "Authorization": "Basic U3VwZXJVc2VyOlNZUw=="})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")


def open_app(page):
    """Opens the test application's details (via another route, so the hash really changes)."""
    page.goto(f"{UI}#/dashboard")
    page.goto(f"{UI}#/webapps/{APP.replace('/', '%2F')}")
    page.wait_for_selector(".modal button:has-text('Edit')")


def settled(page):
    """Waits until the screen finished loading (no spinner left in the main area)."""
    page.wait_for_timeout(300)
    page.wait_for_function("!document.querySelector('main .loading')", timeout=30_000)


def clear_toasts(page):
    page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")


def toast_after(page, action):
    """Runs `action` and returns the text of the toasts it produced (older toasts are cleared first)."""
    clear_toasts(page)
    action()
    page.wait_for_selector(".toast", timeout=15_000)
    return " | ".join(page.locator(".toast").all_inner_texts())


def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, bypass_csp=True)  # the page CSP forbids the eval Playwright uses to wait
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(UI)
        page.fill("#login-user", "SuperUser")
        page.fill("#login-pass", "SYS")
        page.click("button[type=submit]")
        page.wait_for_selector(".sidebar")

        try:
            run_ui_checks(page)
        finally:
            api("DELETE", f"/v2/web-app?name={APP}")
            browser.close()
    assert not errors, f"JavaScript errors: {errors}"
    check_csp()
    print("ALL UI TESTS PASSED")


def check_csp():
    """The checks above run with the page's CSP bypassed (Playwright's waits need eval). Here every screen is
    opened again with the CSP in force, and any violation the browser reports fails the test."""
    violations = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda m: violations.append(m.text) if "Content Security Policy" in m.text else None)
        page.goto(UI)
        page.fill("#login-user", "SuperUser")
        page.fill("#login-pass", "SYS")
        page.click("button[type=submit]")
        page.wait_for_selector(".sidebar")
        for screen in SCREENS:
            page.goto(f"{UI}#/{screen}")
            page.wait_for_selector("main h1")
            page.wait_for_timeout(1500)
        browser.close()
    assert not violations, f"CSP violations: {violations}"
    print("ok   no CSP violations with the policy enforced")


def run_ui_checks(page):
    # 1. Every screen and every tab renders without a JavaScript error or an error box.
    for screen in SCREENS:
        page.goto(f"{UI}#/{screen}")
        settled(page)
        assert page.locator("main .error-box").count() == 0, f"error box on {screen}"
        for tab in page.locator(".tab").all():
            tab.click()
            settled(page)
            assert page.locator("main .error-box").count() == 0, f"error box on {screen}/{tab.inner_text()}"
        print(f"ok   screen {screen}")

    # 2. Command palette finds a task and opens its details.
    page.keyboard.press("Control+k")
    page.fill(".palette-input", "purge tasks")
    page.wait_for_selector(".palette-item.active:has-text('Purge Tasks')")  # objects load asynchronously
    page.keyboard.press("Enter")
    page.wait_for_selector(".modal h2:has-text('Task #')")
    assert "#/tasks/" in page.url
    print("ok   palette opens a task")
    page.keyboard.press("Escape")

    # 3. Verified change: create, edit (read back), stale edit refused, typed-confirm delete.
    page.goto(f"{UI}#/webapps")
    settled(page)
    page.click("text=New REST API")
    page.fill(".modal input[placeholder='/api/my-app']", APP)
    page.fill(".modal #f-DispatchClass", "AdminDeck.REST.Dispatch")
    text = toast_after(page, lambda: page.click(".modal footer button:has-text('Create')"))
    assert "application created" in text.lower() and "read back: ok" in text.lower(), text
    assert api("GET", f"/v2/web-app?name={APP}")["result"]["DispatchClass"] == "AdminDeck.REST.Dispatch"
    print("ok   create web app (verified)")

    open_app(page)
    page.click(".modal button:has-text('Edit')")
    page.fill(".modal #f-Description", "edited by UI test")
    text = toast_after(page, lambda: page.click(".modal footer button:has-text('Save changes')"))
    assert "application saved" in text.lower() and "read back: ok" in text.lower(), text
    assert api("GET", f"/v2/web-app?name={APP}")["result"]["Description"] == "edited by UI test"
    print("ok   edit web app (verified by read-back)")

    open_app(page)
    page.click(".modal button:has-text('Edit')")
    api("PUT", f"/v2/web-app?name={APP}", {"Description": "changed behind the user's back"})
    page.fill(".modal #f-Description", "my change")
    text = toast_after(page, lambda: page.click(".modal footer button:has-text('Save changes')"))
    assert "changed by someone else" in text.lower(), text
    assert api("GET", f"/v2/web-app?name={APP}")["result"]["Description"] == "changed behind the user's back"
    print("ok   stale edit refused, nothing written")
    page.keyboard.press("Escape")

    # The change log lists the verified edit (and the refused one) with the call it made.
    page.wait_for_timeout(1000)  # the log is written in the background, after the toast
    page.goto(f"{UI}#/audit/changes")
    settled(page)
    page.fill(".tab-body input.filter", "Application saved")
    saved = page.locator(".tab-body tbody tr", has_text=f"PUT /api/admin/v2/web-app?name={APP}")
    expect(saved.filter(has=page.locator(".badge.ok", has_text="verified")).first).to_be_visible(timeout=15_000)
    assert "SuperUser" in saved.first.inner_text()
    # Newest first: the refused edit came last
    expect(page.locator(".tab-body tbody tr").first.locator(".badge.warn")).to_have_text("refused")
    print("ok   change log lists the verified edit and the refused one")

    open_app(page)
    page.click(".modal button:has-text('Delete')")
    dialog = page.locator(".modal").last
    confirm = dialog.locator("footer button:has-text('Delete')")
    expect(confirm).to_be_disabled()
    dialog.locator(".confirm-type input").fill(APP[:-1])
    expect(confirm).to_be_disabled()
    dialog.locator(".confirm-type input").fill(APP)
    expect(confirm).to_be_enabled()
    text = toast_after(page, confirm.click)
    assert "application deleted" in text.lower() and "read back: ok" in text.lower(), text
    assert api("GET", f"/v2/web-app?name={APP}")["status"]["errors"], "app still exists"
    print("ok   typed-confirm delete (verified gone)")

    # 4. Timeline reports a status for each of its seven sources.
    page.goto(f"{UI}#/logs")
    page.wait_for_selector("text=events · newest first", timeout=30_000)
    statuses = page.locator(".tab-body .toolbar.small").inner_text()
    for source in SOURCES:
        assert f"{source}:" in statuses, f"no status for {source}: {statuses}"
    print("ok   timeline: status for all seven sources")

    # 5. Journal explorer: records of the newest file, a record's details, "who changed" search.
    page.goto(f"{UI}#/system/journal")
    page.locator(".tab-body tbody tr.clickable").first.locator("button:has-text('Records')").click()
    page.wait_for_selector(".journal-records .journal-status", timeout=60_000)
    assert "newest first" in page.locator(".journal-records .journal-status").inner_text()
    page.locator(".journal-records tbody tr.clickable").first.click()
    page.wait_for_selector(".modal .journal-record")
    page.keyboard.press("Escape")
    page.fill("input[aria-label='Global to find']", "^SYS")
    page.click("button:has-text('Who changed it?')")
    page.wait_for_selector(".journal-records .journal-status:has-text('found')", timeout=60_000)
    print("ok   journal explorer: records, details, who changed")

    # 6. Backups: the tab states the facts of the backup history, and the dashboard agrees with it.
    page.goto(f"{UI}#/system/backups")
    settled(page)
    text = page.locator("main").inner_text()
    assert "FullAllDatabases" in text, "backup definitions listed"
    never = "No backup has run on this instance" in text
    page.goto(f"{UI}#/dashboard")
    page.wait_for_selector(".card:has(h2:has-text('Needs attention')) ul, .card:has(h2:has-text('Needs attention')) .empty-state", timeout=30_000)
    attention = page.locator(".card:has(h2:has-text('Needs attention'))").inner_text()
    if never:
        assert "No backup has run on this instance" in attention, attention
    print(f"ok   backups tab ({'no backup recorded' if never else 'history shown'}) and dashboard item")

    # 7. Interoperability: every enabled namespace has a card with its production state, or enabling is offered.
    page.goto(f"{UI}#/interop")
    settled(page)
    cards = page.locator("main .card h2")
    text = page.locator("main").inner_text()
    assert cards.count() > 0, text[:300]
    assert "No namespace has Interoperability enabled" in text or any(
        s in text for s in ["Running", "Stopped", "Suspended", "Troubled", "No production"]), text[:300]
    if page.locator("main .card:has(h2:has-text('USER')) button:has-text('Open')").count():
        page.click("main .card:has(h2:has-text('USER')) button:has-text('Open')")
        page.wait_for_url("**#/interop/USER")
        settled(page)
        assert page.locator("main .error-box").count() == 0
        assert "Items" in page.locator("main").inner_text() or "ITEMS" in page.locator("main").inner_text()
    print("ok   interoperability screen")

    # 8. Deleting a role lists the users who lose access; Cancel leaves the role in place.
    role, user = f"zzuirole{os.getpid()}", f"zzuiuser{os.getpid()}"
    try:
        api("PUT", f"/v2/security/role?name={role}", {"Description": "UI test", "Resources": [{"Name": "%DB_USER", "Permissions": "RW"}]})
        api("POST", f"/v2/security/user?name={user}", {"User": {"Enabled": True, "Roles": [role]}, "Password": secrets.token_urlsafe(16)})
        assert api("GET", f"/v2/security/user?name={user}")["result"]["Roles"] == [role]
        page.goto(f"{UI}#/dashboard")
        page.goto(f"{UI}#/roles/roles/{role}")
        page.wait_for_selector(".modal button.danger:has-text('Delete')")
        page.click(".modal button.danger:has-text('Delete')")
        dialog = page.locator(".modal").last
        expect(dialog.locator(".access-losers")).to_contain_text(user, timeout=30_000)
        expect(dialog.locator(".access-losers")).to_contain_text("%DB_USER:RW")
        dialog.locator("footer button:has-text('Cancel')").click()
        assert not api("GET", f"/v2/security/role?name={role}")["status"]["errors"], "role deleted on cancel"
        print("ok   role delete lists who loses access; cancel keeps the role")
    finally:
        api("DELETE", f"/v2/security/user?name={user}")
        api("DELETE", f"/v2/security/role?name={role}")

    # 9. API explorer, REST APIs on this instance: the extension's routes, and GET /whoami tried with the portal token.
    page.goto(f"{UI}#/explorer")
    settled(page)
    page.click(".tab:has-text('REST APIs on this instance')")
    settled(page)
    page.click("button.rest-app:has(strong:text-is('/admindeck/api'))")
    page.wait_for_selector("main h3:has-text('Routes (')")
    page.click("button.route:has-text('/whoami')")
    page.click("main button:has-text('Send')")
    page.wait_for_selector("main pre.response")
    response = page.locator("main pre.response").inner_text()
    assert response.startswith("HTTP 200"), response[:300]
    assert '"username": "SuperUser"' in response, response[:500]
    print("ok   REST APIs on this instance: routes of /admindeck/api, GET /whoami 200")

    # 10. Status checks: the demo's dismounted REPORTS is a failing check, listed first, with a Mount button.
    page.goto(f"{UI}#/status")
    card = page.locator("main .card.checks")
    card.locator(".check-row").first.wait_for(timeout=60_000)
    row = card.locator(".check-row[data-check='dismounted']")
    assert "fail" in row.get_attribute("class").split(), row.inner_text()
    assert "REPORTS" in row.inner_text() and "failing" in row.inner_text(), row.inner_text()
    expect(row.locator("button:has-text('Mount')")).to_be_visible()
    assert "fail" in card.locator(".check-row").first.get_attribute("class").split(), "failing checks come first"
    print("ok   status checks: REPORTS dismounted is failing, with Mount")


if __name__ == "__main__":
    main()
