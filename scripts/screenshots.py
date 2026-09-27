"""Regenerates the README screenshots (docs/img/*.png) from a running instance.

    uvx --with playwright python scripts/screenshots.py [base_url]

Best taken after the instance has been up for a while, so the dashboard and status charts have history.
Creates and removes a throw-away web application for the "verified change" shot.
"""
import json
import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:52785").rstrip("/")
UI = f"{BASE}/admindeck/index.html"
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "img")
APP = "/api/orders"


def api(method, path, body=None):
    req = urllib.request.Request(f"{BASE}/api/admin{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "Authorization": "Basic U3VwZXJVc2VyOlNZUw=="})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")


def settle(page, ms=1200):
    page.wait_for_timeout(400)
    page.wait_for_function("!document.querySelector('main .loading')", timeout=30_000)
    page.wait_for_timeout(ms)


def shot(page, name):
    page.screenshot(path=os.path.join(OUT, f"{name}.png"))
    print("saved", name)


def screen(page, route, name, tab=None, ms=1200):
    page.goto(f"{UI}#/dashboard")
    page.goto(f"{UI}#/{route}")
    settle(page)
    if tab:
        page.click(f".tab:has-text('{tab}')")
        settle(page)
    page.wait_for_timeout(ms)
    shot(page, name)


def main():
    api("PUT", f"/v2/web-app?name={APP}", {"NameSpace": "USER", "DispatchClass": "AdminDeck.REST.Dispatch", "AutheEnabled": 32,
                                           "ServeFiles": 0, "Description": "Orders REST API"})
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1, bypass_csp=True)
        page.add_init_script("try { localStorage.setItem('adminDeck.theme', 'light'); localStorage.setItem('adminDeck.sidebar', 'pinned'); } catch (e) {}")
        page.goto(UI)
        page.fill("#login-user", "SuperUser")
        page.fill("#login-pass", "SYS")
        page.click("button[type=submit]")
        page.wait_for_selector(".sidebar")
        try:
            screen(page, "dashboard", "dashboard", ms=2500)
            screen(page, "status", "status", ms=2500)
            screen(page, "webapps", "webapps")
            screen(page, "explorer", "explorer")
            screen(page, "tasks", "tasks")
            screen(page, "roles", "access-matrix", tab="Access matrix")
            screen(page, "secrets", "secrets-x509", tab="X.509 credentials")
            screen(page, "system", "databases")
            screen(page, "logs", "timeline", ms=2500)
            screen(page, "logs", "logs-insights", tab="Recurring problems")
            screen(page, "logs", "logs-similar", tab="Similar incidents")
            page.fill("textarea[aria-label='Incident text']", "Error opening file permission denied")
            page.click("main button:has-text('Find similar')")
            settle(page, 2500)
            shot(page, "logs-similar")

            page.goto(f"{UI}#/dashboard")
            settle(page)
            page.keyboard.press("Control+k")
            page.fill(".palette-input", "orders")
            page.wait_for_timeout(1500)
            shot(page, "palette")
            page.keyboard.press("Escape")

            page.goto(f"{UI}#/webapps/{APP.replace('/', '%2F')}")
            page.wait_for_selector(".modal button:has-text('Edit')")
            page.click(".modal button:has-text('Edit')")
            page.fill(".modal #f-Description", "Orders REST API (v2)")
            page.click(".modal footer button:has-text('Save changes')")
            page.wait_for_selector(".toast", timeout=15_000)
            page.wait_for_timeout(600)
            shot(page, "verified-change")

            page.goto(f"{UI}#/users")
            settle(page)
            page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
            page.click("button.console-button")
            page.wait_for_timeout(1200)
            shot(page, "api-console")
        finally:
            api("DELETE", f"/v2/web-app?name={APP}")
            browser.close()


if __name__ == "__main__":
    main()
