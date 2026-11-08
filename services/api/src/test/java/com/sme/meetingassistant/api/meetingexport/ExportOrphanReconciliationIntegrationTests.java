package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/**
 * Real PostgreSQL / Flyway V37 and production ledger SQL.
 * The private S3 boundary is controlled to simulate old orphans, concurrent
 * ETag change and abandoned scan leases; separate RustFS tests exercise SDK.
 */
@ActiveProfiles("test")
@SpringBootTest(properties={
        "app.media.outbox.enabled=false",
        "app.exports.worker.enabled=false",
        "app.exports.reconciliation.enabled=false",
        "app.exports.reconciliation.purge-enabled=false"
})
@Import({PostgresTestConfiguration.class, ExportOrphanReconciliationIntegrationTests.StorageWiring.class})
class ExportOrphanReconciliationIntegrationTests {
    @TestConfiguration(proxyBeanMethods=false)
    static class StorageWiring {
        @Bean @Primary
        FakeObjectStorage fakeOrphanStorage() { return new FakeObjectStorage(); }
    }

    static final class FakeObjectStorage implements ObjectStorage {
        record Entry(String key, Instant modified, String etag, long size) { }
        final Map<String, Entry> objects=new ConcurrentHashMap<>();
        volatile boolean changeOnDelete;

        void put(String key, Instant modified) {
            objects.put(key,new Entry(key,modified,"etag-"+UUID.randomUUID(),144L));
        }

        void clear() { objects.clear();changeOnDelete=false; }

        @Override
        public ListedObjects list(String prefix,String continuation,int limit) {
            List<Entry> all=objects.values().stream()
                    .filter(e->e.key().startsWith(prefix))
                    .sorted(Comparator.comparing(Entry::key)).toList();
            List<Entry> page=new ArrayList<>();
            for (var e:all) {
                if(continuation!=null && e.key().compareTo(continuation)<=0) continue;
                if(page.size()==limit) break;
                page.add(e);
            }
            String next=null;
            if(!page.isEmpty() && all.stream()
                    .anyMatch(e->e.key().compareTo(page.getLast().key())>0)) {
                next=page.getLast().key();
            }
            return new ListedObjects(page.stream()
                    .map(e->new ListedObject(e.key(),e.modified())).toList(),next);
        }

        @Override public StoredObject head(String key) {
            Entry e=objects.get(key);
            if(e==null) throw new IllegalStateException("Object missing");
            return new StoredObject(e.size(),"application/octet-stream",e.etag(),e.modified());
        }

        @Override public boolean deleteIfEtagMatches(String key,String etag) {
            if(changeOnDelete) {
                Entry old=objects.get(key);
                if(old!=null) objects.put(key,new Entry(key,Instant.now(),
                        "etag-external-replacement",old.size()));
                changeOnDelete=false;
                return false;
            }
            Entry old=objects.get(key);
            if(old==null || !old.etag().equals(etag)) return false;
            return objects.remove(key,old);
        }

        @Override public void delete(String key) {
            throw new UnsupportedOperationException("Unsafe deletion is never allowed");
        }
        @Override public String createUploadCapability(String k,String m,long s,Duration d) {
            throw new UnsupportedOperationException();
        }
        @Override public String createDownloadCapability(String k,Duration d) {
            throw new UnsupportedOperationException();
        }
        @Override public void downloadTo(String k,Path p) throws IOException {
            throw new UnsupportedOperationException();
        }
        @Override public boolean putAcceptedIfAbsent(String k,Path p,String s) {
            throw new UnsupportedOperationException();
        }
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired FakeObjectStorage storage;
    @Autowired ExportOrphanRepository repository;
    @Autowired ExportOrphanReconciler dryRun;

    @BeforeEach
    void reset() {
        storage.clear();
        jdbc.update("DELETE FROM meeting_export_orphan_candidates");
        jdbc.update("""
            UPDATE meeting_export_reconciliation_cursor
               SET continuation_token=NULL,lease_token=NULL,lease_expires_at=NULL
             WHERE id=1
            """);
    }

    private ExportOrphanReconciler approvedPurgeFixture() {
        return new ExportOrphanReconciler(repository,storage,Clock.systemUTC(),
                72,24,3,100,true,"D11-APPROVED-integration-test");
    }

    @Test
    void orphanIsNeverDeletedAtFirstObservationEvenWhenPurgeIsEnabled() {
        UUID id=UUID.randomUUID();
        String key=intakeKey(id);
        storage.put(key,Instant.now().minus(Duration.ofDays(5)));
        ExportOrphanReconciler purge=approvedPurgeFixture();
        var first=purge.runOnce();
        assertThat(first.orphanObserved()).isEqualTo(1);
        assertThat(first.deleted()).isZero();
        assertThat(storage.objects).containsKey(key);
        assertThat(jdbc.queryForObject("""
            SELECT observation_count FROM meeting_export_orphan_candidates
             WHERE object_key=?
            """, Integer.class,key)).isEqualTo(1);
    }

    @Test
    void repeatedOldUnreferencedObjectIsQuarantinedThenConditionallyPurged() {
        UUID id=UUID.randomUUID();
        String key=intakeKey(id);
        storage.put(key,Instant.now().minus(Duration.ofDays(5)));
        dryRun.runOnce();
        jdbc.update("""
            UPDATE meeting_export_orphan_candidates
               SET first_observed_at=clock_timestamp()-INTERVAL '49 hours'
             WHERE object_key=?
            """,key);
        assertThat(approvedPurgeFixture().runOnce().deleted()).isEqualTo(1);
        assertThat(storage.objects).doesNotContainKey(key);
        assertThat(jdbc.queryForObject("""
            SELECT status FROM meeting_export_orphan_candidates
             WHERE object_key=?
            """,String.class,key)).isEqualTo("PURGED");
        // Deletion receipt is durable; rerunning cannot double-purge this key.
        assertThat(approvedPurgeFixture().runOnce().deleted()).isZero();
    }

    @Test
    void anyCommittedExportIdProtectsAllItsObjectsEvenIfNotCurrentKeys() {
        UUID actor=user(), meeting=meeting(actor),exportId=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_exports(id,meeting_id,format,requested_by_user_id)
            VALUES(?,?, 'PDF',?)
            """,exportId,meeting,actor);
        String intake=intakeKey(exportId);
        String snapshot=ExportDigests.snapshotKey(exportId,"a".repeat(64));
        String artifact=ExportDigests.artifactKey(exportId,ExportFormat.PDF,"b".repeat(64));
        Instant old=Instant.now().minus(Duration.ofDays(8));
        storage.put(intake,old);
        storage.put(snapshot,old);
        storage.put(artifact,old);
        assertThat(approvedPurgeFixture().runOnce().orphanObserved()).isZero();
        assertThat(storage.objects.keySet()).contains(intake,snapshot,artifact);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_export_orphan_candidates WHERE export_id=?",
                Long.class,exportId)).isZero();
    }

    @Test
    void changedObjectAtLastMomentIsNotDeletedAndRemainsRetryable() {
        UUID id=UUID.randomUUID();
        String key=ExportDigests.artifactKey(id,ExportFormat.MARKDOWN,"e".repeat(64));
        storage.put(key,Instant.now().minus(Duration.ofDays(6)));
        dryRun.runOnce();
        jdbc.update("""
            UPDATE meeting_export_orphan_candidates
               SET first_observed_at=clock_timestamp()-INTERVAL '25 hours'
             WHERE object_key=?
            """,key);
        storage.changeOnDelete=true;
        assertThat(approvedPurgeFixture().runOnce().deleted()).isZero();
        assertThat(storage.objects).containsKey(key);
        assertThat(jdbc.queryForObject(
                "SELECT last_error_code FROM meeting_export_orphan_candidates WHERE object_key=?",
                String.class,key)).isEqualTo("ETAG_CHANGED");
    }

    @Test
    void replacementWithSameEtagAndSizeButNewLastModifiedIsNotPurged() {
        UUID id=UUID.randomUUID();
        String key=intakeKey(id);
        storage.put(key,Instant.now().minus(Duration.ofDays(7)));
        dryRun.runOnce();
        jdbc.update("""
            UPDATE meeting_export_orphan_candidates
               SET first_observed_at=clock_timestamp()-INTERVAL '30 hours'
             WHERE object_key=?
            """,key);
        FakeObjectStorage.Entry prior=storage.objects.get(key);
        // ABA content: ETag and byte-size unchanged. Only LastModified
        // distinguishes a recently replaced object from old orphan evidence.
        storage.objects.put(key,new FakeObjectStorage.Entry(key,
                Instant.now(),prior.etag(),prior.size()));
        assertThat(approvedPurgeFixture().runOnce().deleted()).isZero();
        assertThat(storage.objects).containsKey(key);
        assertThat(jdbc.queryForObject("""
            SELECT status FROM meeting_export_orphan_candidates WHERE object_key=?
            """,String.class,key)).isEqualTo("OBSERVED");
    }

    @Test
    void concurrentInventoryLeasesNeverAdvanceTheSameCursor() {
        var first=repository.acquireScan().orElseThrow();
        assertThat(repository.acquireScan()).isEmpty();
        assertThat(repository.finishScan(UUID.randomUUID(),"bad-cursor")).isFalse();
        assertThat(repository.finishScan(first.token(),"page-next")).isTrue();
        var later=repository.acquireScan().orElseThrow();
        assertThat(later.cursor()).isEqualTo("page-next");
        repository.abandonScan(later.token());
    }

    @Test
    void physicalDeletionRequiresRealPolicyReferenceAndSafeBounds() {
        assertThatThrownBy(()->new ExportOrphanReconciler(repository,storage,
                Clock.systemUTC(),72,24,3,100,true,"UNAPPROVED"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(()->new ExportOrphanReconciler(repository,storage,
                Clock.systemUTC(),1,24,3,100,false,"UNAPPROVED"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static String intakeKey(UUID id) {
        return "exports/"+id+"/intake/"+"c".repeat(64)+".json";
    }

    private UUID user() {
        UUID id=UUID.randomUUID();
        String email="de11-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                              global_role,account_status)
            VALUES(?,?,?,'DE11 actor','test-only','EMPLOYEE','ACTIVE')
            """,id,email,email);
        return id;
    }

    private UUID meeting(UUID owner) {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES(?,'DE11 fixture',?,?,'DRAFT')
            """,id,owner,owner);
        return id;
    }
}
