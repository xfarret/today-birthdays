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

Install the extension archive:
   ```bash
   gnome-extensions install --force today-birthdays@xfarret.shell-extension.zip
   ```

## Troubleshooting
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered "\[today-birthdays\]"
   ```

## Development

This project is developed with the assistance of AI tools. All changes are planned or approved by the author, and all AI-generated code is reviewed and tested before it is merged.
