package com.sme.meetingassistant.api;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;

@SpringBootTest
@Import(PostgresTestConfiguration.class)
class MeetingAssistantApiApplicationTests {

	@Test
	void contextLoads() {
	}

}
