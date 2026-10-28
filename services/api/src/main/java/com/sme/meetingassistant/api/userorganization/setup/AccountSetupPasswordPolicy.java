package com.sme.meetingassistant.api.userorganization.setup;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * One offline password policy for both account setup and password recovery.
 * No remote lookup, password logging, forced composition or modification of
 * the password that is subsequently hashed. The versioned public wordlist is
 * packaged with the application and missing/corrupt resources fail closed.
 */
@Component
public class AccountSetupPasswordPolicy {
    private static final String RESOURCE = "/security/common-compromised-passwords.txt";
    private static final Pattern NON_ALNUM = Pattern.compile("[^\\p{L}\\p{N}]");

    // Preserve previously blocked long common passwords even if not present
    // in the NCSC source snapshot, whose full list contains many short entries.
    private static final Set<String> PREVIOUSLY_BLOCKED = Set.of(
        "password123456789", "123456789012345", "1234567890123456",
        "qwerty123456789", "qwertyuiop12345", "letmein123456789",
        "admin1234567890", "welcome123456789", "iloveyou12345678",
        "passwordpassword", "changemechangeme", "secretsecretsecret",
        "abcdefghijklmno", "1234567890abcdef");

    // Project, product, organization, role and common department terms. Only
    // exact (possibly doubled) roots with small numeric affixes are rejected,
    // not arbitrary passphrases merely mentioning these words.
    private static final Set<String> CONTEXT = Set.of(
        "meetingassistant", "smemeetingassistant", "smeassistant",
        "meetingassistantproject", "smeproject", "sme",
        "administrator", "systemadministrator", "departmentmanager",
        "manager", "employee", "admin",
        "humanresources", "humanresource", "phongnhansu", "nhansu",
        "accounting", "phongketoan", "ketoan", "finance",
        "engineering", "operations", "marketing");

    private static final Blocklist COMMON = loadBlocklist();

    public void validate(String password) {
        if (password == null) reject();
        int count = password.codePointCount(0, password.length());
        if (count < 15 || count > 128) reject();

        // Comparison-only normalization. The original password passes to
        // Argon2id unchanged, preserving Unicode and whitespace semantics.
        String folded = fold(password);
        String collapsed = collapse(folded);
        // Pure Unicode-symbol passwords can be valid. Never treat the empty
        // collapsed representation as a weak-password dictionary match.
        if (COMMON.exact().contains(folded)
                || (!collapsed.isEmpty() && COMMON.collapsed().contains(collapsed))) reject();

        for (String root : CONTEXT) {
            String word = Pattern.quote(root);
            if (collapsed.matches("[0-9]{0,6}(?:" + word + "){1,2}[0-9]{0,16}")) reject();
        }
    }

    private static Blocklist loadBlocklist() {
        var exact = new HashSet<String>();
        exact.addAll(PREVIOUSLY_BLOCKED);
        try (var stream = AccountSetupPasswordPolicy.class.getResourceAsStream(RESOURCE)) {
            if (stream == null) throw new IllegalStateException("Missing approved password blocklist");
            try (var reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                reader.lines().filter(line -> !line.isBlank() && !line.startsWith("#"))
                    .map(AccountSetupPasswordPolicy::fold).forEach(exact::add);
            }
        } catch (java.io.IOException io) {
            throw new IllegalStateException("Cannot load password blocklist", io);
        }
        // Ensure accidental resource truncation cannot silently weaken policy.
        if (exact.size() < 300) throw new IllegalStateException("Password blocklist incomplete");
        var collapsed = new HashSet<String>();
        for (String value : exact) {
            String candidate = collapse(value);
            if (!candidate.isEmpty()) collapsed.add(candidate);
        }
        return new Blocklist(Set.copyOf(exact), Set.copyOf(collapsed));
    }

    private static String fold(String value) {
        return Normalizer.normalize(value, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
    }

    private static String collapse(String value) {
        return NON_ALNUM.matcher(value).replaceAll("");
    }

    private static void reject() {
        throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
            "Password does not meet policy");
    }

    private record Blocklist(Set<String> exact, Set<String> collapsed) {}
}
