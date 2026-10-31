package com.sme.meetingassistant.api.userorganization.setup;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** F03 SEC-PWD-001..007: bundled offline blocklist + contextual variants. */
class AccountSetupPasswordPolicyTests {
    private final AccountSetupPasswordPolicy policy = new AccountSetupPasswordPolicy();

    private void rejects(String password) {
        assertThatThrownBy(() -> policy.validate(password))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY));
    }

    @Test void longCompromisedValuesFromPinnedPublicCorpusAreRejected() {
        // These were not in the old 14-entry inline list.
        rejects("1q2w3e4r5t6y7u8i9o0p");
        rejects("123456789123456789");
        rejects("1Q2W3E4R5T6Y7U8I9O0P");
        rejects("1q2w3e4r5t6y7u8i9o0p!!!");
        rejects("123456789123456789".replace("1", "１"));
    }

    @Test void compromisedCandidateIsComparedAsWholePasswordNotSubstring() {
        rejects("1q2w3e4r5t6y7u8i9o0p");
        // Screening whole passwords must not penalize a long legitimate
        // passphrase merely because it quotes a weak password as an example.
        policy.validate("This phrase mentions 1q2w3e4r5t6y7u8i9o0p as an example.");
    }

    @Test void bundledResourceDigestRejectsChangesWithoutCountingEntries() throws IOException {
        byte[] original;
        try (var stream = AccountSetupPasswordPolicy.class.getResourceAsStream(
                "/security/common-compromised-passwords.txt")) {
            assertThat(stream).isNotNull();
            original = stream.readAllBytes();
        }
        AccountSetupPasswordPolicy.verifyBlocklistIntegrity(original);

        String windowsLineEndings = new String(original, StandardCharsets.UTF_8)
            .replace("\r\n", "\n")
            .replace("\n", "\r\n");
        AccountSetupPasswordPolicy.verifyBlocklistIntegrity(
            windowsLineEndings.getBytes(StandardCharsets.UTF_8));

        byte[] changed = original.clone();
        changed[changed.length - 2] ^= 1; // Same length/count, different content.
        assertThatThrownBy(() -> AccountSetupPasswordPolicy.verifyBlocklistIntegrity(changed))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("integrity");

        byte[] truncated = Arrays.copyOf(original, original.length - 2);
        assertThatThrownBy(() -> AccountSetupPasswordPolicy.verifyBlocklistIntegrity(truncated))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> AccountSetupPasswordPolicy.verifyBlocklistIntegrity(null))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test void previouslyBlockedPasswordsRemainRejected() {
        rejects("passwordpassword");
        rejects("password123456789");
        rejects("welcome123456789");
    }

    @Test void projectOrganizationRoleAndDepartmentVariantsAreRejected() {
        rejects("SME Meeting Assistant 2026!");
        rejects("meetingassistant2026");
        rejects("Administrator2026");
        rejects("department_manager_2027");
        rejects("Human-Resources-2026");
        rejects("Phong Nhan Su 2026!");
        rejects("Phòng Nhân Sự 2026!");
        rejects("Phòng Kế Toán 2026!");
        rejects("Nhân Sự 2026!!!!");
        rejects("Kế Toán 2026!!!!!");
        rejects("Ban Điều Hành 2026!");
        rejects("SME Meeting Assistant System 2026!");
        rejects("Meeting Assistant System 2026!");
        rejects("phongketoan2026");
        rejects("2026MeetingAssistant");
        rejects("marketingmarketing");
    }

    @Test void legitimateUnicodeSpacesAndLongPassphrasesRemainAllowed() {
        policy.validate("Một câu mật khẩu dài có dấu và dấu cách 🔐");
        policy.validate("My team discussed marketing but chose another strong passphrase 🚀");
        policy.validate("Cuộc họp của Phòng Nhân Sự đã thảo luận phương án mới 🔐");
        policy.validate("Sáng nay Ban Điều Hành đã thống nhất kế hoạch tiếp theo 🔐");
        policy.validate("🚀".repeat(128));
        policy.validate("!".repeat(128)); // Collapsed comparison must not reject empty strings.
        policy.validate("This is a long password with no digit or special punctuation");
        rejects("🚀".repeat(129));
        rejects("short");
        rejects(null);
    }
}
