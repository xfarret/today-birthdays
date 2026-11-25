import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const GOA_BUS_NAME = 'org.gnome.OnlineAccounts';
const GOA_OBJECT_PATH = '/org/gnome/OnlineAccounts';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const GOA_ACCOUNT_IFACE = 'org.gnome.OnlineAccounts.Account';
const GOA_CONTACTS_IFACE = 'org.gnome.OnlineAccounts.Contacts';
const GOA_FILES_IFACE = 'org.gnome.OnlineAccounts.Files';
const GOA_PASSWORD_BASED_IFACE = 'org.gnome.OnlineAccounts.PasswordBased';

const LOG_PREFIX = '[today-birthdays]';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const CARDDAV_REPORT_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
</C:addressbook-query>`;

function logDebug(message) {
    console.log(`${LOG_PREFIX} ${message}`);
}

function dbusCallAsync(conn, busName, objectPath, ifaceName, methodName, parameters, replyType, timeoutMsec = 4000) {
    return new Promise((resolve, reject) => {
        conn.call(
            busName,
            objectPath,
            ifaceName,
            methodName,
            parameters,
            replyType,
            Gio.DBusCallFlags.NONE,
            timeoutMsec,
            null,
            (connection, res) => {
                try {
                    resolve(connection.call_finish(res));
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

function unpackVariantDict(dictVariant) {
    const out = {};
    if (!dictVariant)
        return out;
    const unpacked = dictVariant instanceof GLib.Variant ? dictVariant.deepUnpack() : dictVariant;
    for (const [k, v] of Object.entries(unpacked))
        out[k] = v instanceof GLib.Variant ? v.deepUnpack() : v;
    return out;
}

function decodeXmlEntities(str) {
    return str
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#([0-9]+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function cleanVcardFieldValue(raw) {
    return decodeXmlEntities(raw)
        .replace(/\r/g, '')
        .trim();
}

const BirthdayIndicator = GObject.registerClass(
class BirthdayIndicator extends PanelMenu.Button {
    _init(dbusConnection, settings, openPreferencesCallback, extensionPath) {
        super._init(0.0, 'Today\'s Birthdays', false);
        this._dbus = dbusConnection;
        this._settings = settings;
        this._openPreferences = openPreferencesCallback;
        this._extensionPath = extensionPath;
        this._httpSession = new Soup.Session({timeout: 15});

        this._iconEnableFile = Gio.File.new_for_path(
            GLib.build_filenamev([this._extensionPath, 'icons', 'cake_enable.png'])
        );
        this._iconDisableFile = Gio.File.new_for_path(
            GLib.build_filenamev([this._extensionPath, 'icons', 'cake_disable.png'])
        );

        this._box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
        });

        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({file: this._iconDisableFile}),
            icon_size: 16,
            style_class: 'system-status-icon',
        });

        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);

        this._settingsChangedIds = [
            'upcoming-days',
            'goa-account-id',
            'webdav-url',
            'webdav-username',
            'webdav-password',
        ].map(key => this._settings.connect(`changed::${key}`, () => this.refresh()));

        this.refresh();
    }

    _setCakeState(hasAnyBirthday) {
        const targetFile = hasAnyBirthday ? this._iconEnableFile : this._iconDisableFile;
        this._icon.set_gicon(new Gio.FileIcon({file: targetFile}));
    }

    destroy() {
        if (this._settingsChangedIds && this._settings) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);
            this._settingsChangedIds = [];
        }
        if (this._httpSession) {
            this._httpSession.abort();
            this._httpSession = null;
        }
        super.destroy();
    }

    async _resolveGoaConnectionInfo() {
        const accountId = this._settings.get_string('goa-account-id').trim();
        let url = this._settings.get_string('webdav-url').trim();
        let username = this._settings.get_string('webdav-username').trim();
        let password = this._settings.get_string('webdav-password');

        logDebug(`GOA accountId="${accountId || '(aucun)'}", initial url="${url || '(vide)'}", username="${username || '(vide)'}"`);

        if (!accountId)
            return {url, username, password};

        try {
            const reply = await dbusCallAsync(
                this._dbus,
                GOA_BUS_NAME,
                GOA_OBJECT_PATH,
                OBJECT_MANAGER_IFACE,
                'GetManagedObjects',
                null,
                new GLib.VariantType('(a{oa{sa{sv}}})'),
                4000
            );

            const [managedObjects] = reply.deepUnpack();
            for (const [objPath, ifaces] of Object.entries(managedObjects)) {
                if (!ifaces[GOA_ACCOUNT_IFACE])
                    continue;

                const accProps = unpackVariantDict(ifaces[GOA_ACCOUNT_IFACE]);
                if (accProps.Id !== accountId && objPath !== accountId)
                    continue;

                const contactsProps = unpackVariantDict(ifaces[GOA_CONTACTS_IFACE]);
                const filesProps = unpackVariantDict(ifaces[GOA_FILES_IFACE]);

                if (!url)
                    url = contactsProps.Uri || filesProps.Uri || '';
                if (!username)
                    username = accProps.Identity || accProps.PresentationIdentity || '';

                if (!password && ifaces[GOA_PASSWORD_BASED_IFACE]) {
                    try {
                        const pwReply = await dbusCallAsync(
                            this._dbus,
                            GOA_BUS_NAME,
                            objPath,
                            GOA_PASSWORD_BASED_IFACE,
                            'GetPassword',
                            new GLib.Variant('(s)', ['password']),
                            new GLib.VariantType('(s)'),
                            3000
                        );
                        const [secret] = pwReply.deepUnpack();
                        if (secret)
                            password = secret;
                    } catch (_pwErr) {
                        logDebug(`GetPassword GOA indisponible pour ${objPath}`);
                    }
                }
                break;
            }
        } catch (err) {
            logDebug(`Erreur lecture GOA : ${err.message}`);
        }

        logDebug(`Connexion résolue -> url="${url || '(vide)'}", username="${username || '(vide)'}", hasPassword=${Boolean(password)}`);
        return {url, username, password};
    }

    _sendCardDavRequest(method, url, username, password, body = null, depth = '1') {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new(method, url);
            if (!msg) {
                reject(new Error(`URL invalide : ${url}`));
                return;
            }

            const headers = msg.get_request_headers();
            headers.append('Depth', depth);
            if (username || password) {
                const token = GLib.base64_encode(
                    new TextEncoder().encode(`${username}:${password}`)
                );
                headers.append('Authorization', `Basic ${token}`);
            }

            if (body) {
                const bytes = new GLib.Bytes(new TextEncoder().encode(body));
                msg.set_request_body_from_bytes('application/xml; charset=utf-8', bytes);
            }

            this._httpSession.send_and_read_async(
                msg,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        const status = msg.get_status();
                        const text = new TextDecoder('utf-8').decode(bytes.get_data() || new Uint8Array());
                        resolve({status, text});
                    } catch (err) {
                        reject(err);
                    }
                }
            );
        });
    }

    async _fetchVcardsFromWebDav({url, username, password}) {
        if (!url)
            throw new Error('Aucune URL WebDAV/CardDAV configurée.');

        logDebug(`Requête REPORT CardDAV sur ${url}`);
        const reportRes = await this._sendCardDavRequest(
            'REPORT',
            url,
            username,
            password,
            CARDDAV_REPORT_BODY,
            '1'
        );
        logDebug(`Réponse REPORT -> HTTP ${reportRes.status} (${reportRes.text.length} octets)`);

        if (reportRes.status >= 200 && reportRes.status < 300) {
            const vcards = [];
            const regex = /<[^:>]*:?address-data[^>]*>([\s\S]*?)<\/[^:>]*:?address-data>/gi;
            let m;
            while ((m = regex.exec(reportRes.text)) !== null)
                vcards.push(decodeXmlEntities(m[1]));

            logDebug(`REPORT address-data extraits : ${vcards.length}`);
            if (vcards.length > 0)
                return vcards.join('\n');
        }

        if (reportRes.status === 401 || reportRes.status === 403)
            throw new Error('Authentification WebDAV refusée (401/403).');

        logDebug(`Repli PROPFIND sur ${url}`);
        const propfindRes = await this._sendCardDavRequest('PROPFIND', url, username, password, null, '1');
        logDebug(`Réponse PROPFIND -> HTTP ${propfindRes.status} (${propfindRes.text.length} octets)`);

        if (propfindRes.status < 200 || propfindRes.status >= 300)
            throw new Error(`Erreur serveur WebDAV (HTTP ${propfindRes.status})`);

        const hrefs = new Set();
        const hrefRegex = /<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/gi;
        let hm;
        while ((hm = hrefRegex.exec(propfindRes.text)) !== null) {
            const href = decodeXmlEntities(hm[1]).trim();
            if (href.toLowerCase().endsWith('.vcf'))
                hrefs.add(href);
        }

        logDebug(`Fichiers .vcf trouvés via PROPFIND : ${hrefs.size}`);

        const baseUri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        const allCards = [];

        for (const href of hrefs) {
            const resolvedUri = baseUri.parse_relative(href, GLib.UriFlags.NONE).to_string();
            const getRes = await this._sendCardDavRequest('GET', resolvedUri, username, password, null, '0');
            if (getRes.status >= 200 && getRes.status < 300)
                allCards.push(getRes.text);
            else
                logDebug(`Échec GET ${resolvedUri} -> HTTP ${getRes.status}`);
        }

        logDebug(`Fiches .vcf téléchargées : ${allCards.length}`);
        return allCards.join('\n');
    }

    _parseBirthday(rawValue) {
        if (!rawValue)
            return null;

        let clean = cleanVcardFieldValue(rawValue.split(':').pop());
        clean = clean.replace(/T.*$/i, '').trim();

        let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
        if (match) {
            return {
                year: Number.parseInt(match[1], 10),
                month: Number.parseInt(match[2], 10),
                day: Number.parseInt(match[3], 10),
            };
        }

        match = /^(\d{4})(\d{2})(\d{2})$/.exec(clean);
        if (match) {
            return {
                year: Number.parseInt(match[1], 10),
                month: Number.parseInt(match[2], 10),
                day: Number.parseInt(match[3], 10),
            };
        }

        match = /^--(\d{2})-?(\d{2})$/.exec(clean);
        if (match) {
            return {
                year: null,
                month: Number.parseInt(match[1], 10),
                day: Number.parseInt(match[2], 10),
            };
        }

        return null;
    }

    _computeNextOccurrence(bday, todayMidnight) {
        const currentYear = todayMidnight.getFullYear();

        const buildDateForYear = (year) => {
            const candidate = new Date(year, bday.month - 1, bday.day);
            if (bday.month === 2 && bday.day === 29 && candidate.getMonth() !== 1)
                return new Date(year, 1, 28);
            return candidate;
        };

        let target = buildDateForYear(currentYear);
        if (target.getTime() < todayMidnight.getTime())
            target = buildDateForYear(currentYear + 1);

        const daysUntil = Math.round((target.getTime() - todayMidnight.getTime()) / MS_PER_DAY);
        const turningAge = bday.year ? target.getFullYear() - bday.year : null;

        return {
            daysUntil,
            targetDate: target,
            turningAge: turningAge && turningAge > 0 ? turningAge : null,
        };
    }

    _extractBirthdaysFromVcfContent(content, todayMidnight, maxUpcomingDays) {
        const today = [];
        const upcoming = [];

        const unfolded = content.replace(/\r?\n[ \t]/g, '');
        const cards = unfolded.split(/BEGIN:VCARD/i).slice(1);
        let bdayCount = 0;

        logDebug(`Analyse de ${cards.length} fiche(s) vCard`);

        for (const card of cards) {
            let fn = '';
            let bdayRaw = '';

            for (const line of card.split(/\r?\n/)) {
                if (/^FN([;:]|$)/i.test(line))
                    fn = cleanVcardFieldValue(line.split(':').slice(1).join(':'));
                else if (/^BDAY([;:]|$)/i.test(line))
                    bdayRaw = cleanVcardFieldValue(line);
            }

            const bday = this._parseBirthday(bdayRaw);
            if (!bday) {
                if (bdayRaw)
                    logDebug(`BDAY non reconnu pour "${fn || '(Sans nom)'}" : "${bdayRaw}"`);
                continue;
            }

            bdayCount++;
            const info = this._computeNextOccurrence(bday, todayMidnight);
            const entry = {
                name: fn || 'Contact sans nom',
                age: info.turningAge,
                daysUntil: info.daysUntil,
                targetDate: info.targetDate,
            };

            if (info.daysUntil === 0)
                today.push(entry);
            else if (info.daysUntil > 0 && info.daysUntil <= maxUpcomingDays)
                upcoming.push(entry);
        }

        logDebug(`Fiches avec BDAY reconnu : ${bdayCount} | Aujourd'hui : ${today.length} | À venir (${maxUpcomingDays} j) : ${upcoming.length}`);

        today.sort((a, b) => a.name.localeCompare(b.name));
        upcoming.sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name));

        return {today, upcoming};
    }

    _formatShortDate(date) {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        return `${day}/${month}`;
    }

    _appendFooterActions() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Actualiser');
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Paramètres');
        prefsItem.connect('activate', () => this._openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    async refresh() {
        const maxUpcomingDays = this._settings.get_int('upcoming-days');

        try {
            const connInfo = await this._resolveGoaConnectionInfo();
            const vcfContent = await this._fetchVcardsFromWebDav(connInfo);

            const now = new Date();
            const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const {today, upcoming} = this._extractBirthdaysFromVcfContent(
                vcfContent,
                todayMidnight,
                maxUpcomingDays
            );

            const hasAnyBirthday = today.length > 0 || upcoming.length > 0;
            this._setCakeState(hasAnyBirthday);

            this.menu.removeAll();

            const todayHeader = new PopupMenu.PopupMenuItem('Aujourd\'hui', {reactive: false});
            todayHeader.label.add_style_class_name('popup-subtitle-menu-item');
            this.menu.addMenuItem(todayHeader);

            if (today.length === 0) {
                this._label.set_text('');
                this._label.visible = false;
                this.menu.addMenuItem(
                    new PopupMenu.PopupMenuItem('Aucun anniversaire aujourd\'hui', {reactive: false})
                );
            } else {
                this._label.set_text(`${today.length}`);
                this._label.visible = true;

                for (const entry of today) {
                    const text = entry.age ? `${entry.name} (${entry.age} ans)` : entry.name;
                    this.menu.addMenuItem(new PopupMenu.PopupMenuItem(text, {reactive: false}));
                }
            }

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const upcomingHeader = new PopupMenu.PopupMenuItem(
                `À venir (${maxUpcomingDays} j)`,
                {reactive: false}
            );
            upcomingHeader.label.add_style_class_name('popup-subtitle-menu-item');
            this.menu.addMenuItem(upcomingHeader);

            if (upcoming.length === 0) {
                this.menu.addMenuItem(
                    new PopupMenu.PopupMenuItem(
                        `Aucun anniversaire dans les ${maxUpcomingDays} prochains jours`,
                        {reactive: false}
                    )
                );
            } else {
                for (const entry of upcoming) {
                    const when = entry.daysUntil === 1
                        ? 'demain'
                        : `dans ${entry.daysUntil} j (${this._formatShortDate(entry.targetDate)})`;
                    const agePart = entry.age ? ` — ${entry.age} ans` : '';
                    const text = `${entry.name} · ${when}${agePart}`;
                    this.menu.addMenuItem(new PopupMenu.PopupMenuItem(text, {reactive: false}));
                }
            }

            this._appendFooterActions();
        } catch (err) {
            logDebug(`Erreur refresh : ${err.message}`);
            this._setCakeState(false);
            this.menu.removeAll();
            this._label.set_text('!');
            this._label.visible = true;
            this.menu.addMenuItem(
                new PopupMenu.PopupMenuItem(err.message || 'Erreur de synchronisation WebDAV', {reactive: false})
            );
            this._appendFooterActions();
        }
    }
});

export default class TodayBirthdaysExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new BirthdayIndicator(
            Gio.DBus.session,
            this._settings,
            () => this.openPreferences(),
            this.path
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            3600,
            () => {
                this._indicator.refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    disable() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}
