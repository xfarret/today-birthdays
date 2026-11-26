# Today's Birthdays — GNOME Shell Extension

A lightweight **GNOME Shell 50** top-bar extension that fetches your contacts directly from a **WebDAV / CardDAV** address book (such as Infomaniak, Nextcloud, or ownCloud) and displays today's and upcoming birthdays in a clean panel menu.

---

## Features

* **Direct CardDAV Synchronization:** Queries your address book over HTTP(S) using CardDAV `REPORT` (`addressbook-query`) with automatic fallback to `PROPFIND` + `GET` on individual `.vcf` files.
* **GNOME Online Accounts (GOA) Integration:** Detects configured accounts over D-Bus (`org.gnome.OnlineAccounts`) in the preferences window to pre-fill your address book URL, username, and credentials when available, while supporting full manual configuration.
* **Dynamic Top-Bar Cake Icon:**
  * Displays the lit birthday cake icon (`icons/cake_enable.png`) when at least one birthday falls today or within your configured upcoming window, along with a badge count when someone has a birthday today.
  * Displays the grayscale cake icon (`icons/cake_disable.png`) when no birthdays are upcoming or during a sync error.
* **Configurable Lookahead Window:** Choose how many days ahead (`1` to `365`, default `14`) to preview in the dropdown menu.
* **Robust vCard `BDAY` Parsing:** Supports `YYYY-MM-DD`, `YYYYMMDD`, and yearless `--MMDD` / `--MM-DD` formats, automatically handles XML character entities (`&#13;`, etc.), and calculates turning ages when birth years are present.

---

## Requirements

* **GNOME Shell:** `50`
* **GNOME Libraries:** `Soup 3.0`, `Adw` (Libadwaita), `Gtk 4`, `Gio`, `GLib`
* A **CardDAV** address book URL and valid credentials (or an app password if two-factor authentication is enabled on your provider)

---

## Installation

### From the Release ZIP Package

1. Install the extension archive:
   ```bash
   gnome-extensions install --force today-birthdays@xfarret.shell-extension.zip
   ```
2. Enable the extension:
   ```bash
   gnome-extensions enable today-birthdays@xfarret
   ```
3. *(Wayland / GNOME Shell)* If the extension does not immediately appear, log out and log back in, then verify its status:
   ```bash
   gnome-extensions info today-birthdays@xfarret
   ```

### Manual Installation from Source

1. Copy the repository files into your local GNOME Shell extensions directory:
   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/today-birthdays@xfarret
   cp -r metadata.json extension.js prefs.js schemas icons ~/.local/share/gnome-shell/extensions/today-birthdays@xfarret/
   ```
2. Compile the GSettings schema:
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/today-birthdays@xfarret/schemas/
   ```
3. Enable the extension:
   ```bash
   gnome-extensions enable today-birthdays@xfarret
   ```

---

## Configuration

1. Click the cake icon in the top bar and select **Paramètres** (or run `gnome-extensions prefs today-birthdays@xfarret`).
2. **Online Account (Optional):** Select an account detected from GNOME Online Accounts to pre-populate your connection details, or leave it on manual configuration.
3. **WebDAV / CardDAV Connection:**
   * **CardDAV Address Book URL:** Full URL to your CardDAV collection (e.g., `https://contacts.infomaniak.com/addressbooks/users/<username>/default/` or `https://cloud.example.com/remote.php/dav/addressbooks/users/<username>/contacts/`).
   * **Username:** Your CardDAV login identifier.
   * **Password:** Your password or provider-specific application password (used if GOA does not expose the secret directly).
4. **Upcoming Days:** Set the number of days ahead to check for upcoming birthdays.

---

## Troubleshooting & Logs

The extension logs diagnostic details prefixed with `[today-birthdays]` to the GNOME Shell journal. To watch synchronization in real time:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered "\[today-birthdays\]"
```

Click **Actualiser** in the extension menu to trigger an immediate refresh and inspect the resolved URL, HTTP status codes, and number of parsed vCards.

---

## Project Structure

```text
today-birthdays@xfarret/
├── extension.js                                              # Main panel indicator, GOA/CardDAV sync, and vCard parser
├── prefs.js                                                  # Libadwaita preferences window with D-Bus GOA account selector
├── metadata.json                                             # GNOME Shell extension metadata
├── icons/
│   ├── cake_enable.png                                       # Active icon (birthday today or within upcoming days)
│   └── cake_disable.png                                      # Inactive icon (no upcoming birthdays)
└── schemas/
    └── org.gnome.shell.extensions.today-birthdays.gschema.xml # GSettings schema definition
```


---

## Development

This project is developed with the assistance of AI tools. All changes are planned or approved by the author, and all AI-generated code is reviewed and tested before it is merged.

---

## License

MIT License.