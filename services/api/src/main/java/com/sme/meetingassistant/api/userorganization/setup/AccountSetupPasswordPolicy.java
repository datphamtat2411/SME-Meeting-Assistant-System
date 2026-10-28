package com.sme.meetingassistant.api.userorganization.setup;

import java.util.Locale;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/** Unicode code-point limit and basic common/contextual password blocklist. */
@Component
public class AccountSetupPasswordPolicy {
    private static final Set<String> BLOCKED = Set.of(
        "password123456789", "123456789012345", "1234567890123456",
        "qwerty123456789", "qwertyuiop12345", "letmein123456789",
        "admin1234567890", "welcome123456789", "iloveyou12345678",
        "passwordpassword", "changemechangeme", "secretsecretsecret",
        "abcdefghijklmno", "1234567890abcdef");
    private static final Set<String> CONTEXT = Set.of(
        "meetingassistant", "smemeetingassistant", "administrator", "departmentmanager");

    public void validate(String password) {
        if (password == null) reject();
        int count = password.codePointCount(0, password.length());
        if (count < 15 || count > 128) reject();
        String lower = password.toLowerCase(Locale.ROOT);
        String collapsed = lower.replaceAll("[^\\p{L}\\p{N}]", "");
        if (BLOCKED.contains(lower) || BLOCKED.contains(collapsed)) reject();
        for (String word : CONTEXT) {
            if (collapsed.matches(java.util.regex.Pattern.quote(word) + "(?:20[0-9]{2}|[0-9]*)")) reject();
        }
    }

    private static void reject() {
        throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Password does not meet policy");
    }
}
