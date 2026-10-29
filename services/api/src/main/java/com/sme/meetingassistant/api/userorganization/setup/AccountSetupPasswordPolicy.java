package com.sme.meetingassistant.api.userorganization.setup;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * One offline password policy for both account setup and password recovery.
 * Comparisons use normalized copies only; the accepted password is hashed
 * unchanged by the existing Argon2id boundary.
 */
@Component
public class AccountSetupPasswordPolicy {
    private static final String RESOURCE = "/security/common-compromised-passwords.txt";
    // SHA-256 of the exact UTF-8 classpath resource, reviewed and pinned with
    // the source revision in F03_PASSWORD_BLOCKLIST_POLICY.md.
    private static final String RESOURCE_SHA256 =
        "103e8b4890736ea3447ab53bce03381fc2697293a0339a5cfd83e28ff3f71cca";
    private static final Pattern NON_ALNUM = Pattern.compile("[^\\p{L}\\p{N}]");
    private static final Pattern COMBINING_MARKS = Pattern.compile("\\p{M}+");

    // Preserve previously blocked long common passwords.
    private static final Set<String> PREVIOUSLY_BLOCKED = Set.of(
        "password123456789", "123456789012345", "1234567890123456",
        "qwerty123456789", "qwertyuiop12345", "letmein123456789",
        "admin1234567890", "welcome123456789", "iloveyou12345678",
        "passwordpassword", "changemechangeme", "secretsecretsecret",
        "abcdefghijklmno", "1234567890abcdef");

    // Known product/project/role/common department roots. The comparison key
    // is accent-insensitive only for these anchored context checks.
    private static final Set<String> CONTEXT = Set.of(
        "meetingassistant", "smemeetingassistant", "smeassistant",
        "meetingassistantsystem", "smemeetingassistantsystem",
        "meetingassistantproject", "smeproject", "sme",
        "administrator", "systemadministrator", "departmentmanager",
        "manager", "employee", "admin",
        "humanresources", "humanresource", "phongnhansu", "nhansu",
        "accounting", "phongketoan", "ketoan", "finance",
        "engineering", "operations", "marketing",
        "bandieuhanh", "dieuhanh");

    private static final Blocklist COMMON = loadBlocklist();

    public void validate(String password) {
        if (password == null) reject();
        int count = password.codePointCount(0, password.length());
        if (count < 15 || count > 128) reject();

        String folded = fold(password);
        String collapsed = collapse(folded);
        // Do not treat symbol-only passwords as an empty dictionary entry.
        if (COMMON.exact().contains(folded)
                || (!collapsed.isEmpty() && COMMON.collapsed().contains(collapsed))) reject();

        String context = contextKey(folded);
        for (String root : CONTEXT) {
            String quoted = Pattern.quote(root);
            // Whole-password root / doubled root with bounded numeric affixes.
            // A longer passphrase that merely mentions a department remains valid.
            if (context.matches("[0-9]{0,6}(?:" + quoted + "){1,2}[0-9]{0,16}")) reject();
        }
    }

    private static Blocklist loadBlocklist() {
        byte[] bytes;
        try (var stream = AccountSetupPasswordPolicy.class.getResourceAsStream(RESOURCE)) {
            if (stream == null) throw new IllegalStateException("Missing password blocklist");
            bytes = stream.readAllBytes();
        } catch (IOException ex) {
            throw new IllegalStateException("Cannot load password blocklist", ex);
        }
        verifyBlocklistIntegrity(bytes);

        var exact = new HashSet<String>(PREVIOUSLY_BLOCKED);
        new String(bytes, StandardCharsets.UTF_8).lines()
            .filter(line -> !line.isBlank() && !line.startsWith("#"))
            .map(AccountSetupPasswordPolicy::fold)
            .forEach(exact::add);
        var collapsed = new HashSet<String>();
        for (String value : exact) {
            String candidate = collapse(value);
            if (!candidate.isEmpty()) collapsed.add(candidate);
        }
        return new Blocklist(Set.copyOf(exact), Set.copyOf(collapsed));
    }

    // Package-private to verify accepted/corrupted/missing resources without
    // weakening the production classpath startup check or injecting test data.
    static void verifyBlocklistIntegrity(byte[] bytes) {
        if (bytes == null) throw new IllegalStateException("Missing password blocklist");
        try {
            String actual = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(bytes));
            if (!RESOURCE_SHA256.equals(actual)) {
                throw new IllegalStateException("Password blocklist integrity check failed");
            }
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 not available", ex);
        }
    }

    private static String fold(String value) {
        return Normalizer.normalize(value, Normalizer.Form.NFKC)
            .toLowerCase(Locale.ROOT);
    }

    private static String collapse(String value) {
        return NON_ALNUM.matcher(value).replaceAll("");
    }

    private static String contextKey(String folded) {
        String decomposed = Normalizer.normalize(folded, Normalizer.Form.NFD);
        String unaccented = COMBINING_MARKS.matcher(decomposed).replaceAll("")
            .replace('đ', 'd');
        return collapse(unaccented);
    }

    private static void reject() {
        throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
            "Password does not meet policy");
    }

    private record Blocklist(Set<String> exact, Set<String> collapsed) {}
}
