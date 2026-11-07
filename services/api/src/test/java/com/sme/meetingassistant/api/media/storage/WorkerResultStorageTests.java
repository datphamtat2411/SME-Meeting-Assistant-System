package com.sme.meetingassistant.api.media.storage;

import static org.assertj.core.api.Assertions.*;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.io.IOException;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

/** Real SDK streaming against a controlled HTTP S3 fixture; TLS is covered by transport fixtures. */
class WorkerResultStorageTests {
    @Test void sdkEnforcesDeclaredAndActualStreamingBounds() throws Exception {
        var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/",exchange->{
            byte[] bytes="123456789".getBytes();
            exchange.getResponseHeaders().add("Content-Type","application/json");
            exchange.sendResponseHeaders(200,exchange.getRequestURI().getPath().endsWith("chunked")?0:bytes.length);
            try(var output=exchange.getResponseBody()){output.write(bytes);} finally {exchange.close();}
        }); server.start();
        var properties=new MediaProperties(); var storage=properties.getStorage();
        storage.setEndpoint("http://127.0.0.1:"+server.getAddress().getPort());storage.setRegion("us-east-1");storage.setBucket("worker-test");
        storage.setAccessKey("test");storage.setSecretKey("test-only");
        var adapter=new S3ObjectStorageAdapter(properties);
        try {
            assertThat(adapter.readBounded("fits",9)).isEqualTo("123456789".getBytes());
            assertThat(adapter.readBounded("diarization",16_777_216)).isEqualTo("123456789".getBytes());
            assertThatThrownBy(()->adapter.readBounded("too-large-limit",16_777_217)).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(()->adapter.delete("processing/11111111-1111-4111-8111-111111111111/diarization/results/22222222-2222-4222-8222-222222222222.json"))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("Diarization result objects are immutable.");
            assertThatThrownBy(()->adapter.readBounded("large",8)).isInstanceOf(IOException.class);
            assertThatThrownBy(()->adapter.readBounded("chunked",8)).isInstanceOf(IOException.class);
        } finally {ReflectionTestUtils.invokeMethod(adapter,"closeClients");server.stop(0);}
    }
}
