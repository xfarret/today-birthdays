import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const GOA_BUS_NAME = 'org.gnome.OnlineAccounts';
const GOA_OBJECT_PATH = '/org/gnome/OnlineAccounts';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const GOA_ACCOUNT_IFACE = 'org.gnome.OnlineAccounts.Account';
const GOA_CONTACTS_IFACE = 'org.gnome.OnlineAccounts.Contacts';
const GOA_FILES_IFACE = 'org.gnome.OnlineAccounts.Files';
const GOA_PASSWORD_BASED_IFACE = 'org.gnome.OnlineAccounts.PasswordBased';

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

async function listGoaAccounts() {
    const conn = Gio.DBus.session;
    const reply = await dbusCallAsync(
        conn,
        GOA_BUS_NAME,
        GOA_OBJECT_PATH,
        OBJECT_MANAGER_IFACE,
        'GetManagedObjects',
        null,
        new GLib.VariantType('(a{oa{sa{sv}}})'),
        4000
    );

    const [managedObjects] = reply.deepUnpack();
    const accounts = [];

    for (const [objPath, ifaces] of Object.entries(managedObjects)) {
        if (!ifaces[GOA_ACCOUNT_IFACE])
            continue;

        const accProps = unpackVariantDict(ifaces[GOA_ACCOUNT_IFACE]);
        const contactsProps = unpackVariantDict(ifaces[GOA_CONTACTS_IFACE]);
        const filesProps = unpackVariantDict(ifaces[GOA_FILES_IFACE]);

        const providerName = accProps.ProviderName || accProps.ProviderType || 'Compte';
        const identity = accProps.PresentationIdentity || accProps.Identity || accProps.Id || objPath;
        const contactsUri = contactsProps.Uri || filesProps.Uri || '';

        accounts.push({
            objectPath: objPath,
            id: accProps.Id || objPath,
            providerType: accProps.ProviderType || '',
            providerName,
            identity,
            hasContacts: Boolean(ifaces[GOA_CONTACTS_IFACE]),
            hasPasswordBased: Boolean(ifaces[GOA_PASSWORD_BASED_IFACE]),
            contactsUri,
            label: `${providerName} — ${identity}`,
        });
    }

    accounts.sort((a, b) => {
        if (a.hasContacts !== b.hasContacts)
            return a.hasContacts ? -1 : 1;
        return a.label.localeCompare(b.label);
    });

    return accounts;
}

export default class TodayBirthdaysPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Général',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const accountGroup = new Adw.PreferencesGroup({
            title: 'Source de contacts (Comptes en ligne)',
            description: 'Sélectionnez un compte configuré dans GNOME Online Accounts (WebDAV, Nextcloud, ownCloud…).',
        });
        page.add(accountGroup);

        const stringList = new Gtk.StringList();
        stringList.append('Configuration manuelle uniquement');

        const accountCombo = new Adw.ComboRow({
            title: 'Compte en ligne',
            subtitle: 'Interrogation D-Bus de org.gnome.OnlineAccounts',
            model: stringList,
        });
        accountGroup.add(accountCombo);

        const statusRow = new Adw.ActionRow({
            title: 'État D-Bus',
            subtitle: 'Chargement des comptes en ligne…',
        });
        accountGroup.add(statusRow);

        const webdavGroup = new Adw.PreferencesGroup({
            title: 'Connexion WebDAV / CardDAV',
            description: 'Vérifiez l’URL complète du carnet d’adresses CardDAV et les identifiants.',
        });
        page.add(webdavGroup);

        const urlRow = new Adw.EntryRow({
            title: 'URL du carnet CardDAV',
            text: settings.get_string('webdav-url'),
        });
        webdavGroup.add(urlRow);
        settings.bind('webdav-url', urlRow, 'text', Gio.SettingsBindFlags.DEFAULT);

        const userRow = new Adw.EntryRow({
            title: 'Identifiant utilisateur',
            text: settings.get_string('webdav-username'),
        });
        webdavGroup.add(userRow);
        settings.bind('webdav-username', userRow, 'text', Gio.SettingsBindFlags.DEFAULT);

        const passRow = new Adw.PasswordEntryRow({
            title: 'Mot de passe (si non récupéré via GOA)',
            text: settings.get_string('webdav-password'),
        });
        webdavGroup.add(passRow);
        settings.bind('webdav-password', passRow, 'text', Gio.SettingsBindFlags.DEFAULT);

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Anniversaires à venir',
            description: 'Configurez la fenêtre de prévisualisation dans le menu déroulant.',
        });
        page.add(displayGroup);

        const spinRow = new Adw.SpinRow({
            title: 'Nombre de jours à venir',
            subtitle: 'Affiche les anniversaires prévus dans les X prochains jours',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 365,
                step_increment: 1,
                page_increment: 7,
                value: settings.get_int('upcoming-days'),
            }),
        });
        displayGroup.add(spinRow);
        settings.bind('upcoming-days', spinRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        let accounts = [];
        let suppressSelectionCallback = true;

        try {
            accounts = await listGoaAccounts();
            for (const acc of accounts)
                stringList.append(acc.label);

            const savedId = settings.get_string('goa-account-id');
            const foundIdx = accounts.findIndex(a => a.id === savedId);
            if (foundIdx >= 0)
                accountCombo.set_selected(foundIdx + 1);
            else
                accountCombo.set_selected(0);

            statusRow.set_subtitle(
                accounts.length > 0
                    ? `${accounts.length} compte(s) détecté(s) via D-Bus.`
                    : 'Aucun compte détecté dans Comptes en ligne.'
            );
        } catch (err) {
            statusRow.set_subtitle(`Impossible de joindre org.gnome.OnlineAccounts : ${err.message}`);
        } finally {
            suppressSelectionCallback = false;
        }

        accountCombo.connect('notify::selected', () => {
            if (suppressSelectionCallback)
                return;

            const idx = accountCombo.get_selected();
            if (idx === 0) {
                settings.set_string('goa-account-id', '');
                return;
            }

            const selectedAcc = accounts[idx - 1];
            if (!selectedAcc)
                return;

            settings.set_string('goa-account-id', selectedAcc.id);
            if (selectedAcc.identity && !settings.get_string('webdav-username'))
                settings.set_string('webdav-username', selectedAcc.identity);
            if (selectedAcc.contactsUri)
                settings.set_string('webdav-url', selectedAcc.contactsUri);
        });
    }
}
