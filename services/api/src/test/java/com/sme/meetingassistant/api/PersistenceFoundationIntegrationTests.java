package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.zaxxer.hikari.HikariDataSource;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class PersistenceFoundationIntegrationTests {

	@Autowired
	private DataSource dataSource;

	@Autowired
	private PostgreSQLContainer<?> postgresContainer;

	@Test
	void applicationDataSourceUsesTheDisposablePostgresContainer() throws Exception {
		assertThat(this.dataSource).isInstanceOf(HikariDataSource.class);
		assertThat(((HikariDataSource) this.dataSource).getJdbcUrl()).isEqualTo(this.postgresContainer.getJdbcUrl());
		try (var connection = this.dataSource.getConnection()) {
			assertThat(connection.getMetaData().getDatabaseProductName()).isEqualTo("PostgreSQL");
		}
	}

}
