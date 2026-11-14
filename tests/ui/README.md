# Browser tests (Playwright, Python)

Click through the real screens: login, leads, quotations, payments, support desk, customer portal, sign-up.

```
pip install playwright && playwright install chromium
# start the API locally with DEMO_MODE=true SEED_DEMO=true on port 8090, then:
python tests/ui/t_ui_flows.py
python tests/ui/t_v18.py   # support desk
python tests/ui/t_cust.py  # customer web portal
```
`h2.py` holds the shared helpers (`BASE`, `login`, `api`).
