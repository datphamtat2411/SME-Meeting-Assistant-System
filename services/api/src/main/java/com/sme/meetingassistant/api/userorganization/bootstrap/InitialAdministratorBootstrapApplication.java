package com.sme.meetingassistant.api.userorganization.bootstrap;

import com.sme.meetingassistant.api.MeetingAssistantApiApplication;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.ConfigurableApplicationContext;

/** Dedicated non-web entry point for the explicit initial-admin command. */
public final class InitialAdministratorBootstrapApplication {
    private InitialAdministratorBootstrapApplication() {}

    public static void main(String[] args) {
        SpringApplication application = new SpringApplication(MeetingAssistantApiApplication.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        try (ConfigurableApplicationContext ignored = application.run(args)) {
            // The conditional ApplicationRunner performs the one requested operation.
        }
    }
}
