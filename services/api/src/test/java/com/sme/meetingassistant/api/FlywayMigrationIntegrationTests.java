package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationState;
import org.flywaydb.core.api.exception.FlywayValidateException;
import org.flywaydb.core.api.output.MigrateResult;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.core.env.Environment;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;

@ActiveProfiles("test")
@SpringBootTest(properties = "spring.flyway.locations=classpath:db/flyway-fixtures/valid")
@Import(PostgresTestConfiguration.class)
class FlywayMigrationIntegrationTests {

	private static final String VALID_LOCATION = "classpath:db/flyway-fixtures/valid";
	private static final String MODIFIED_LOCATION = "classpath:db/flyway-fixtures/modified";
	private static final String FAILING_LOCATION = "classpath:db/flyway-fixtures/failing";
	private static final String MISSING_LOCATION = "classpath:db/flyway-fixtures/missing";
	private static final String PROBE_TABLE = "foundation_probe";
	private static final String PROBE_DESCRIPTION = "migration foundation probe";

	@Autowired
	private DataSource dataSource;

	@Autowired
	private Environment environment;

	@Autowired
	private Flyway flyway;

	@Autowired
	private PostgreSQLContainer<?> postgresContainer;

	@Test
	void springBootStartupAutomaticallyAppliesTheValidMigration() throws Exception {
		assertThat(this.dataSource).isInstanceOf(HikariDataSource.class);
		assertThat(((HikariDataSource) this.dataSource).getJdbcUrl()).isEqualTo(this.postgresContainer.getJdbcUrl());
		try (Connection connection = this.dataSource.getConnection()) {
			assertThat(connection.getMetaData().getDatabaseProductName()).isEqualTo("PostgreSQL");
		}

		String schema = defaultSchema(this.flyway);
		assertThat(tableExists(this.dataSource, schema, PROBE_TABLE)).isTrue();
		assertThat(tableColumns(this.dataSource, schema, PROBE_TABLE))
				.containsExactlyInAnyOrder("id", "description");
		assertProbeRow(this.dataSource, schema, PROBE_TABLE);
		assertSuccessfulHistoryRow(this.flyway, schema);

		MigrationInfo migration = migrationInfo(this.flyway, "1");
		assertThat(migration.getDescription()).isEqualTo("create foundation probe");
		assertThat(migration.getState()).isEqualTo(MigrationState.SUCCESS);
	}

	@Test
	void rerunningFlywayDoesNotRepeatTheAppliedMigration() throws Exception {
		String schema = createIsolatedSchema();
		Flyway isolatedFlyway = configuredFlyway(VALID_LOCATION, schema);

		MigrateResult firstResult = isolatedFlyway.migrate();
		assertThat(firstResult.success).isTrue();
		assertThat(firstResult.migrationsExecuted).isEqualTo(1);
		assertProbeRow(this.dataSource, schema, PROBE_TABLE);

		MigrateResult secondResult = isolatedFlyway.migrate();
		assertThat(secondResult.success).isTrue();
		assertThat(secondResult.migrationsExecuted).isZero();
		assertThat(secondResult.getSuccessfulMigrations()).isEmpty();
		assertThat(tableExists(this.dataSource, schema, PROBE_TABLE)).isTrue();
		assertProbeRow(this.dataSource, schema, PROBE_TABLE);
		assertThat(historyRowCount(isolatedFlyway, schema)).isEqualTo(1);
		assertThat(migrationInfo(isolatedFlyway, "1").getState()).isEqualTo(MigrationState.SUCCESS);
	}

	@Test
	void modifiedAppliedMigrationFailsChecksumValidation() throws Exception {
		String schema = createIsolatedSchema();
		Flyway validFlyway = configuredFlyway(VALID_LOCATION, schema);
		validFlyway.migrate();

		Integer originalChecksum = migrationInfo(validFlyway, "1").getChecksum();
		assertThat(originalChecksum).isNotNull();
		assertProbeRow(this.dataSource, schema, PROBE_TABLE);

		Flyway modifiedFlyway = configuredFlyway(MODIFIED_LOCATION, schema);
		MigrationInfo modifiedMigration = migrationInfo(modifiedFlyway, "1");
		assertThat(modifiedMigration.isChecksumMatching()).isFalse();
		assertThatThrownBy(modifiedFlyway::validate).isInstanceOf(FlywayValidateException.class);

		assertProbeRow(this.dataSource, schema, PROBE_TABLE);
		assertThat(historyRowCount(modifiedFlyway, schema)).isEqualTo(1);
		assertThat(historyChecksum(modifiedFlyway, schema, "1")).isEqualTo(originalChecksum);
		assertThat(migrationInfo(modifiedFlyway, "1").isChecksumMatching()).isFalse();
	}

	@Test
	void failedTransactionalMigrationDoesNotLeaveSchemaOrSuccessfulHistory() throws Exception {
		String schema = createIsolatedSchema();
		Flyway failingFlyway = configuredFlyway(FAILING_LOCATION, schema);

		assertThatThrownBy(failingFlyway::migrate).isInstanceOf(FlywayException.class);

		assertThat(tableExists(this.dataSource, schema, "foundation_failure_probe")).isFalse();
		assertThat(failingFlyway.info().applied())
				.noneMatch(info -> "1".equals(info.getVersion().getVersion()));
		assertThat(migrationInfo(failingFlyway, "1").getState()).isNotEqualTo(MigrationState.SUCCESS);
		assertThat(historyRowCount(failingFlyway, schema)).isZero();
	}

	@Test
	void missingAppliedMigrationFailsValidationWithoutRewritingHistory() throws Exception {
		String schema = createIsolatedSchema();
		Flyway validFlyway = configuredFlyway(VALID_LOCATION, schema);
		validFlyway.migrate();

		Flyway missingFlyway = configuredFlyway(MISSING_LOCATION, schema);
		MigrationInfo missingMigration = migrationInfo(missingFlyway, "1");
		assertThat(missingMigration.getState()).isEqualTo(MigrationState.MISSING_SUCCESS);
		assertThat(missingMigration.getResolvedChecksum()).isNull();
		assertThat(Arrays.stream(missingFlyway.info().pending()))
				.noneMatch(info -> "1".equals(info.getVersion().getVersion()));
		assertThatThrownBy(missingFlyway::validate).isInstanceOf(FlywayValidateException.class);

		assertProbeRow(this.dataSource, schema, PROBE_TABLE);
		assertThat(historyRowCount(missingFlyway, schema)).isEqualTo(1);
		assertThat(migrationInfo(missingFlyway, "1").getState()).isEqualTo(MigrationState.MISSING_SUCCESS);
	}

	@Test
	void persistenceSafetySettingsRemainEnforced() {
		assertThat(this.environment.getProperty("spring.flyway.enabled", Boolean.class)).isTrue();
		assertThat(this.flyway).isNotNull();

		var configuration = this.flyway.getConfiguration();
		assertThat(configuration.isValidateOnMigrate()).isTrue();
		assertThat(configuration.isValidateMigrationNaming()).isTrue();
		assertThat(configuration.isBaselineOnMigrate()).isFalse();
		assertThat(configuration.isOutOfOrder()).isFalse();
		assertThat(configuration.isFailOnMissingLocations()).isTrue();
		assertThat(configuration.isCleanDisabled()).isTrue();

		assertThat(this.environment.getProperty("spring.jpa.hibernate.ddl-auto")).isEqualTo("none");
		assertThat(this.environment.getProperty("spring.jpa.generate-ddl", Boolean.class)).isFalse();
		assertThat(this.environment.getProperty("spring.sql.init.mode")).isEqualTo("never");
	}

	private Flyway configuredFlyway(String location, String schema) {
		return Flyway.configure()
				.dataSource(this.dataSource)
				.locations(location)
				.schemas(schema)
				.defaultSchema(schema)
				.validateOnMigrate(true)
				.validateMigrationNaming(true)
				.baselineOnMigrate(false)
				.outOfOrder(false)
				.failOnMissingLocations(true)
				.cleanDisabled(true)
				.load();
	}

	private String createIsolatedSchema() throws SQLException {
		String schema = "flyway_test_" + UUID.randomUUID().toString().replace("-", "");
		try (Connection connection = this.dataSource.getConnection();
				Statement statement = connection.createStatement()) {
			statement.execute("CREATE SCHEMA " + quoteIdentifier(schema));
		}
		return schema;
	}

	private static String defaultSchema(Flyway flyway) {
		String schema = flyway.getConfiguration().getDefaultSchema();
		return schema == null || schema.isBlank() ? "public" : schema;
	}
	
	private static MigrationInfo migrationInfo(Flyway flyway, String version) {
		return Arrays.stream(flyway.info().all())
				.filter(info -> info.getVersion() != null && version.equals(info.getVersion().getVersion()))
				.findFirst()
				.orElseThrow(() -> new AssertionError("Migration version " + version + " was not found"));
	}

	private static void assertProbeRow(DataSource dataSource, String schema, String table) throws SQLException {
		try (Connection connection = dataSource.getConnection();
				PreparedStatement statement = connection.prepareStatement(
						"SELECT id, description FROM " + qualifiedIdentifier(schema, table));
				ResultSet resultSet = statement.executeQuery()) {
			assertThat(resultSet.next()).isTrue();
			assertThat(resultSet.getLong("id")).isEqualTo(1L);
			assertThat(resultSet.getString("description")).isEqualTo(PROBE_DESCRIPTION);
			assertThat(resultSet.next()).isFalse();
		}
	}

	private static Set<String> tableColumns(DataSource dataSource, String schema, String table) throws SQLException {
		Set<String> columns = new HashSet<>();
		try (Connection connection = dataSource.getConnection();
				PreparedStatement statement = connection.prepareStatement(
						"SELECT column_name FROM information_schema.columns "
								+ "WHERE table_schema = ? AND table_name = ?")) {
			statement.setString(1, schema);
			statement.setString(2, table);
			try (ResultSet resultSet = statement.executeQuery()) {
				while (resultSet.next()) {
					columns.add(resultSet.getString("column_name"));
				}
			}
		}
		return columns;
	}

	private static boolean tableExists(DataSource dataSource, String schema, String table) throws SQLException {
		try (Connection connection = dataSource.getConnection();
				PreparedStatement statement = connection.prepareStatement(
						"SELECT EXISTS (SELECT 1 FROM information_schema.tables "
								+ "WHERE table_schema = ? AND table_name = ?)")) {
			statement.setString(1, schema);
			statement.setString(2, table);
			try (ResultSet resultSet = statement.executeQuery()) {
				assertThat(resultSet.next()).isTrue();
				return resultSet.getBoolean(1);
			}
		}
	}

	private static void assertSuccessfulHistoryRow(Flyway flyway, String schema) throws SQLException {
		try (Connection connection = dataSource(flyway).getConnection();
				PreparedStatement statement = connection.prepareStatement(
						"SELECT version, description, success FROM " + historyTable(flyway, schema))) {
			try (ResultSet resultSet = statement.executeQuery()) {
				assertThat(resultSet.next()).isTrue();
				assertThat(resultSet.getString("version")).isEqualTo("1");
				assertThat(resultSet.getString("description")).isEqualTo("create foundation probe");
				assertThat(resultSet.getBoolean("success")).isTrue();
				assertThat(resultSet.next()).isFalse();
			}
		}
	}

	private static long historyRowCount(Flyway flyway, String schema) throws SQLException {
		try (Connection connection = dataSource(flyway).getConnection();
				PreparedStatement statement = connection.prepareStatement(
						"SELECT COUNT(*) FROM " + historyTable(flyway, schema))) {
			try (ResultSet resultSet = statement.executeQuery()) {
				assertThat(resultSet.next()).isTrue();
				return resultSet.getLong(1);
			}
		}
	}

	private static Integer historyChecksum(Flyway flyway, String schema, String version) throws SQLException {
		try (Connection connection = dataSource(flyway).getConnection();
				PreparedStatement statement = connection.prepareStatement(
						"SELECT checksum FROM " + historyTable(flyway, schema) + " WHERE version = ?")) {
			statement.setString(1, version);
			try (ResultSet resultSet = statement.executeQuery()) {
				assertThat(resultSet.next()).isTrue();
				int checksum = resultSet.getInt(1);
				assertThat(resultSet.wasNull()).isFalse();
				return checksum;
			}
		}
	}

	private static DataSource dataSource(Flyway flyway) {
		return flyway.getConfiguration().getDataSource();
	}

	private static String historyTable(Flyway flyway, String schema) {
		return qualifiedIdentifier(schema, flyway.getConfiguration().getTable());
	}

	private static String qualifiedIdentifier(String schema, String table) {
		return quoteIdentifier(schema) + "." + quoteIdentifier(table);
	}

	private static String quoteIdentifier(String identifier) {
		return "\"" + identifier.replace("\"", "\"\"") + "\"";
	}

}
