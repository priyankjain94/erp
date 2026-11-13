# Test the app on your own computer

1. Install **Docker Desktop** (docker.com/products/docker-desktop) and open it once.
2. Download this repo (green **Code → Download ZIP**) and unzip it.
3. Double-click **start-demo.bat** (Windows) or run `./start-demo.sh` (Mac). The first start takes 3–5 minutes.
4. Open **http://localhost:8080**. On a phone on the same Wi-Fi, use `http://<your-PC-IP>:8080`.

Login codes are shown on screen in this demo. WhatsApp is simulated, so no messages are sent. Sample data is loaded.

## Demo logins (type the 10 digits)

| Number | Person | Role |
|---|---|---|
| 9000000001 | Owner | Admin, sees everything |
| 9000000002 | Meera | Operations head |
| 9000000003 | Vikram | Project manager |
| 9000000004 / 05 / 06 | Ankit / Priya / Rahul | Sales |
| 9000000007 | Sana | Site surveyor (use phone size) |
| 9000000008 / 09 | Deepa / Arjun | Designers |
| 9000000010 | Manish | Purchase |
| 9000000011 | Kiran | Production |
| 9000000012 / 13 / 14 | Ravi / Suresh / Imran | Installation teams (use phone size) |

Customer portal: **http://localhost:8080/c**, number **9827890116** (Vivek Soni, project P-101).

## Things to try
- **Meera** → Installer management → *Add installation team* → assign project items to it → log in as that team's number on a phone.
- **Owner** → CRM → mark a lead Won → *Convert to project*.
- **Sana** → open the survey → rooms, walls A–D, photos → submit. Items appear in Design.
- **Designer** → upload a drawing → *Send to customer* → approve it in the customer portal.
- **Ravi** → open a job → tick boxes, report a missing box → start/pause → complete with the customer OTP.
- **Owner** → Users and access → change a role permission and see it take effect.

Reset everything to sample data: owner → rail menu → *Reset demo*.  
Stop: `docker compose -f docker-compose.demo.yml down` (add `-v` to delete the demo data).
