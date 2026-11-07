package com.sme.meetingassistant.api.media.diarization;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Component;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Bounded, database-derived rolling-window gauges; never count replayable events. */
@Component
public class DiarizationMetrics {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate snapshotTransaction;
    private volatile Snapshot cached;
    private volatile long refreshedAt;
    private boolean attempted;

    public record Snapshot(long accepted,long failed,long retries,long successfulDurationCount,
            double successfulDurationSeconds,long failedDurationCount,double failedDurationSeconds,
            long measurements,long speakerSum,long unknownSum,long speakerZero,long speakerOne,
            long speakerTwo,long speakerFive,long speakerTen,long unknownZero,long unknownOne,
            long unknownFive,long unknownTen,long unknownHundred,long latency30,long latency120,
            long latency300,long latency900,long latency3600,long leaseExpirations,Backlog backlog) { }

    public record Backlog(long outstanding,long actionable,long stale,long superseded,double oldestAgeSeconds) { }
    public static final Set<String> EXPORTED_NAMES=Set.of(
        "diarization.window.outcomes","diarization.window.retries","diarization.window.stage.duration.count",
        "diarization.window.stage.duration.seconds","diarization.window.stage.duration.bucket",
        "diarization.window.accepted.measurements","diarization.window.speakers.sum","diarization.window.speakers.bucket",
        "diarization.window.unknown.assignments.sum","diarization.window.unknown.assignments.bucket",
        "diarization.window.lease.expirations","diarization.verified.only.outstanding",
        "diarization.verified.only.count","diarization.verified.only.oldest.age.seconds","diarization.metrics.aggregation.healthy");

    public DiarizationMetrics(JdbcTemplate jdbc, MeterRegistry registry) {
        this.jdbc=new JdbcTemplate(java.util.Objects.requireNonNull(jdbc.getDataSource()));
        this.jdbc.setQueryTimeout(5);
        snapshotTransaction=new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        snapshotTransaction.setReadOnly(true);
        snapshotTransaction.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        snapshotTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        gauge(registry,"diarization.window.lease.expirations",null,null,s->s.leaseExpirations());
        gauge(registry,"diarization.verified.only.outstanding",null,null,s->s.backlog().outstanding());
        gauge(registry,"diarization.verified.only.count","state","actionable",s->s.backlog().actionable());
        gauge(registry,"diarization.verified.only.count","state","stale",s->s.backlog().stale());
        gauge(registry,"diarization.verified.only.count","state","superseded",s->s.backlog().superseded());
        gauge(registry,"diarization.verified.only.oldest.age.seconds",null,null,s->s.backlog().oldestAgeSeconds());
        Gauge.builder("diarization.metrics.aggregation.healthy",this,m->m.current()==null?0:1).register(registry);
        gauge(registry,"diarization.window.outcomes", "outcome", "accepted", s->s.accepted());
        gauge(registry,"diarization.window.outcomes", "outcome", "failed", s->s.failed());
        gauge(registry,"diarization.window.retries", null, null, s->s.retries());
        gauge(registry,"diarization.window.stage.duration.count", "outcome", "accepted", s->s.successfulDurationCount());
        gauge(registry,"diarization.window.stage.duration.seconds", "outcome", "accepted", s->s.successfulDurationSeconds());
        gauge(registry,"diarization.window.stage.duration.count", "outcome", "failed", s->s.failedDurationCount());
        gauge(registry,"diarization.window.stage.duration.seconds", "outcome", "failed", s->s.failedDurationSeconds());
        gauge(registry,"diarization.window.stage.duration.bucket", "le_seconds", "30", s->s.latency30());
        gauge(registry,"diarization.window.stage.duration.bucket", "le_seconds", "120", s->s.latency120());
        gauge(registry,"diarization.window.stage.duration.bucket", "le_seconds", "300", s->s.latency300());
        gauge(registry,"diarization.window.stage.duration.bucket", "le_seconds", "900", s->s.latency900());
        gauge(registry,"diarization.window.stage.duration.bucket", "le_seconds", "3600", s->s.latency3600());
        gauge(registry,"diarization.window.stage.duration.bucket", "le_seconds", "infinity", s->s.successfulDurationCount()+s.failedDurationCount());
        gauge(registry,"diarization.window.accepted.measurements",null,null,s->s.measurements());
        gauge(registry,"diarization.window.speakers.sum",null,null,s->s.speakerSum());
        gauge(registry,"diarization.window.unknown.assignments.sum",null,null,s->s.unknownSum());
        gauge(registry,"diarization.window.speakers.bucket","le","0",s->s.speakerZero());
        gauge(registry,"diarization.window.speakers.bucket","le","1",s->s.speakerOne());
        gauge(registry,"diarization.window.speakers.bucket","le","2",s->s.speakerTwo());
        gauge(registry,"diarization.window.speakers.bucket","le","5",s->s.speakerFive());
        gauge(registry,"diarization.window.speakers.bucket","le","10",s->s.speakerTen());
        gauge(registry,"diarization.window.speakers.bucket","le","1000",s->s.measurements());
        gauge(registry,"diarization.window.unknown.assignments.bucket","le","0",s->s.unknownZero());
        gauge(registry,"diarization.window.unknown.assignments.bucket","le","1",s->s.unknownOne());
        gauge(registry,"diarization.window.unknown.assignments.bucket","le","5",s->s.unknownFive());
        gauge(registry,"diarization.window.unknown.assignments.bucket","le","10",s->s.unknownTen());
        gauge(registry,"diarization.window.unknown.assignments.bucket","le","100",s->s.unknownHundred());
        gauge(registry,"diarization.window.unknown.assignments.bucket","le","16384",s->s.measurements());
    }

    private interface Value { double get(Snapshot s); }
    private void gauge(MeterRegistry registry,String name,String tag,String value,Value getter) {
        var builder=Gauge.builder(name,this,metrics->{
            Snapshot s=metrics.current();return s==null?Double.NaN:getter.get(s);
        });
        if(tag!=null) builder.tag(tag,value);
        builder.register(registry);
    }

    private synchronized Snapshot current() {
        long now=System.nanoTime();
        if(!attempted || now-refreshedAt>=60_000_000_000L) {
            attempted=true;
            refreshedAt=now;
            try { cached=read(null); }
            catch (org.springframework.dao.DataAccessException | org.springframework.transaction.TransactionException failure) { cached=null; }
        }
        return cached;
    }

    /** A 24-hour half-open window; no identifiers, text or arbitrary SQL input. */
    Snapshot read(OffsetDateTime end) {
        return snapshotTransaction.execute(tx->readSnapshot(end==null
            ?jdbc.queryForObject("SELECT transaction_timestamp()",OffsetDateTime.class):end));
    }

    private Snapshot readSnapshot(OffsetDateTime end) {
        OffsetDateTime start=end.minusHours(24);
        Map<String,Object> outcomes=jdbc.queryForMap("""
            SELECT count(*) FILTER (WHERE outcome='RESULT_ACCEPTED') AS accepted,
                   count(*) FILTER (WHERE outcome='FAILURE_RECORDED') AS failed,
                   count(*) FILTER (WHERE error_code='STAGE_LEASE_EXPIRED') AS expired
            FROM diarization_worker_receipts WHERE recorded_at>=? AND recorded_at<?
            """,start,end);
        Map<String,Object> stages=jdbc.queryForMap("""
            SELECT count(*) FILTER (WHERE r.outcome='RESULT_ACCEPTED' AND s.started_at IS NOT NULL AND s.completed_at>=s.started_at) AS success_count,
                coalesce(sum(extract(epoch from s.completed_at-s.started_at)) FILTER (WHERE r.outcome='RESULT_ACCEPTED' AND s.started_at IS NOT NULL AND s.completed_at>=s.started_at),0) AS success_seconds,
                count(*) FILTER (WHERE r.outcome='FAILURE_RECORDED' AND s.started_at IS NOT NULL AND s.completed_at>=s.started_at) AS failed_count,
                coalesce(sum(extract(epoch from s.completed_at-s.started_at)) FILTER (WHERE r.outcome='FAILURE_RECORDED' AND s.started_at IS NOT NULL AND s.completed_at>=s.started_at),0) AS failed_seconds,
                count(*) FILTER (WHERE s.started_at IS NOT NULL AND s.completed_at>=s.started_at AND s.completed_at-s.started_at<=interval '30 seconds') AS l30,
                count(*) FILTER (WHERE s.started_at IS NOT NULL AND s.completed_at>=s.started_at AND s.completed_at-s.started_at<=interval '120 seconds') AS l120,
                count(*) FILTER (WHERE s.started_at IS NOT NULL AND s.completed_at>=s.started_at AND s.completed_at-s.started_at<=interval '300 seconds') AS l300,
                count(*) FILTER (WHERE s.started_at IS NOT NULL AND s.completed_at>=s.started_at AND s.completed_at-s.started_at<=interval '900 seconds') AS l900,
                count(*) FILTER (WHERE s.started_at IS NOT NULL AND s.completed_at>=s.started_at AND s.completed_at-s.started_at<=interval '3600 seconds') AS l3600
            FROM processing_stage_runs s JOIN diarization_worker_receipts r ON r.execution_stage_run_id=s.id
            WHERE s.stage_code='DIARIZING' AND s.completed_at>=? AND s.completed_at<?
            """,start,end);
        Long retries=jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs WHERE stage_code='DIARIZING' AND attempt_number>1
              AND created_at>=? AND created_at<?
            """,Long.class,start,end);
        Map<String,Object> m=jdbc.queryForMap("""
            SELECT count(*) AS n,coalesce(sum(speaker_count),0) AS speakers,coalesce(sum(unknown_assignment_count),0) AS unknowns,
              count(*) FILTER (WHERE speaker_count<=0) AS s0,count(*) FILTER (WHERE speaker_count<=1) AS s1,
              count(*) FILTER (WHERE speaker_count<=2) AS s2,count(*) FILTER (WHERE speaker_count<=5) AS s5,
              count(*) FILTER (WHERE speaker_count<=10) AS s10,
              count(*) FILTER (WHERE unknown_assignment_count<=0) AS u0,count(*) FILTER (WHERE unknown_assignment_count<=1) AS u1,
              count(*) FILTER (WHERE unknown_assignment_count<=5) AS u5,count(*) FILTER (WHERE unknown_assignment_count<=10) AS u10,
              count(*) FILTER (WHERE unknown_assignment_count<=100) AS u100
            FROM diarization_acceptance_measurements WHERE recorded_at>=? AND recorded_at<?
            """,start,end);
        Map<String,Object> backlog=jdbc.queryForMap("""
            SELECT count(*) AS outstanding,
                count(*) FILTER (WHERE state='actionable') AS actionable,
                count(*) FILTER (WHERE state='stale') AS stale,
                count(*) FILTER (WHERE state='superseded') AS superseded,
                coalesce(greatest(0,extract(epoch FROM CAST(? AS timestamptz)-min(verified_at))),0) AS age
            FROM (SELECT verified_at, CASE WHEN superseded THEN 'superseded'
                WHEN current_binding AND lease_expires_at>? THEN 'actionable' ELSE 'stale' END AS state
                FROM diarization_verified_only_backlog) classified
            """,end,end);
        return new Snapshot(n(outcomes,"accepted"),n(outcomes,"failed"),retries,n(stages,"success_count"),d(stages,"success_seconds"),
            n(stages,"failed_count"),d(stages,"failed_seconds"),n(m,"n"),n(m,"speakers"),n(m,"unknowns"),
            n(m,"s0"),n(m,"s1"),n(m,"s2"),n(m,"s5"),n(m,"s10"),n(m,"u0"),n(m,"u1"),n(m,"u5"),n(m,"u10"),n(m,"u100"),
            n(stages,"l30"),n(stages,"l120"),n(stages,"l300"),n(stages,"l900"),n(stages,"l3600"),n(outcomes,"expired"),
            new Backlog(n(backlog,"outstanding"),n(backlog,"actionable"),n(backlog,"stale"),n(backlog,"superseded"),d(backlog,"age")));
    }
    private static long n(Map<String,Object> row,String name) { return ((Number)row.get(name)).longValue(); }
    private static double d(Map<String,Object> row,String name) { return ((Number)row.get(name)).doubleValue(); }
}
