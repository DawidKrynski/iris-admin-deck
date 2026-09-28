"""End-to-end UI tests (Playwright, headless Chromium) against a running instance.

    uvx --with playwright python -m playwright install chromium   # once
    uvx --with playwright python tests/e2e/test_ui.py [base_url]

Uses a throw-away web application named per run and always removes it. Exits non-zero on the first failure.
"""
import json
import os
import sys
import urllib.request

from playwright.sync_api import expect, sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:52785").rstrip("/")
UI = f"{BASE}/admindeck/index.html"
APP = f"/zzuitest-{os.getpid()}"
SOURCES = ["messages.log", "alerts.log", "System Monitor", "Journal log", "Application errors", "Audit", "Task Manager"]
SCREENS = ["dashboard", "webapps", "explorer", "users", "roles", "secrets", "tasks", "processes", "system", "status", "logs", "audit"]


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
    print("ALL UI TESTS PASSED")


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
    assert "application created" in text.lower() and "verified" in text.lower(), text
    assert api("GET", f"/v2/web-app?name={APP}")["result"]["DispatchClass"] == "AdminDeck.REST.Dispatch"
    print("ok   create web app (verified)")

    open_app(page)
    page.click(".modal button:has-text('Edit')")
    page.fill(".modal #f-Description", "edited by UI test")
    text = toast_after(page, lambda: page.click(".modal footer button:has-text('Save changes')"))
    assert "application saved" in text.lower() and "verified" in text.lower(), text
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
    assert "application deleted" in text.lower() and "verified" in text.lower(), text
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


if __name__ == "__main__":
    main()
