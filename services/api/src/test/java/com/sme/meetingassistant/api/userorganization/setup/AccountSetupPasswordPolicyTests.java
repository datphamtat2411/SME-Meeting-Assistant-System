package com.sme.meetingassistant.api.userorganization.setup;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
        rejects("phongketoan2026");
        rejects("2026MeetingAssistant");
        rejects("marketingmarketing");
    }

    @Test void legitimateUnicodeSpacesAndLongPassphrasesRemainAllowed() {
        policy.validate("Một câu mật khẩu dài có dấu và dấu cách 🔐");
        policy.validate("My team discussed marketing but chose another strong passphrase 🚀");
        policy.validate("🚀".repeat(128));
        policy.validate("This is a long password with no digit or special punctuation");
        rejects("🚀".repeat(129));
        rejects("short");
        rejects(null);
    }
}
