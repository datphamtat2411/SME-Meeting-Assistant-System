package com.sme.meetingassistant.api.media.worker;

import static org.assertj.core.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class WorkerJsonTests {
    @Test void rejectsDuplicateUnknownCoercedAndOversizedCommands() {
        assertThatThrownBy(() -> WorkerJson.parse("{\"a\":1,\"a\":2}".getBytes(StandardCharsets.UTF_8), 16384))
            .isInstanceOf(WorkerException.class);
        assertThatThrownBy(() -> WorkerJson.parse(new byte[16385], 16384)).isInstanceOf(WorkerException.class);
        var node = WorkerJson.parse("{\"generation\":true}".getBytes(StandardCharsets.UTF_8), 16384);
        assertThatThrownBy(() -> WorkerJson.number(node, "generation", 0, 3)).isInstanceOf(WorkerException.class);
        assertThatThrownBy(() -> WorkerJson.fields(node, "other")).isInstanceOf(WorkerException.class);
        assertThatThrownBy(() -> WorkerJson.uuid(WorkerJson.parse("{\"id\":\"1-1-1-1-1\"}".getBytes(), 16384), "id"))
            .isInstanceOf(WorkerException.class);
    }
    @Test void rejectsMalformedUtf8BomAndTrailingJson() {
        for (byte[] bytes : new byte[][]{{(byte)0xc3, 0x28}, {(byte)0xef,(byte)0xbb,(byte)0xbf,123,125}, "{} {}".getBytes()})
            assertThatThrownBy(() -> WorkerJson.parse(bytes, 16384)).isInstanceOf(WorkerException.class);
    }
    @Test void sharedControlFixturesMatchStrictCommands() throws Exception {
        try(var input=getClass().getResourceAsStream("/worker-v1/operations.json")) {
            var fixtures=WorkerJson.parse(input.readAllBytes(),16384);
            WorkerCommands.claim(fixtures.get("claim"));WorkerCommands.renew(fixtures.get("renew"));
            WorkerCommands.complete(fixtures.get("complete"));WorkerCommands.fail(fixtures.get("fail"));
            for(var invalid:fixtures.get("invalidMutations")) {
                String op=invalid.get("operation").asString(); if(op.equals("readDelivery")) continue;
                var n=(tools.jackson.databind.node.ObjectNode)fixtures.get(op).deepCopy();
                invalid.get("set").properties().forEach(p->n.set(p.getKey(),p.getValue()));
                assertThatThrownBy(()->{switch(op){case "claim"->WorkerCommands.claim(n);case "renew"->WorkerCommands.renew(n);
                    case "complete"->WorkerCommands.complete(n);case "fail"->WorkerCommands.fail(n);default->throw new AssertionError();}})
                    .isInstanceOf(WorkerException.class);
            }
        }
    }
}
