package com.sme.meetingassistant.api.support;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** A bounded in-memory fake for source object I/O; business/DB services remain real. */
public final class ImmutableSnapshotObjectFixture {
    private ImmutableSnapshotObjectFixture() {}

    public static void install(ObjectStorage storage) throws Exception {
        Map<String,byte[]> objects=new ConcurrentHashMap<>();
        when(storage.putAcceptedIfAbsent(anyString(),any(Path.class),anyString()))
            .thenAnswer(invocation -> objects.putIfAbsent(invocation.getArgument(0),
                Files.readAllBytes(invocation.getArgument(1)))==null);
        when(storage.head(anyString())).thenAnswer(invocation -> {
            byte[] contents=objects.get((String)invocation.getArgument(0));
            if(contents==null) throw new IllegalStateException("No source object.");
            return new ObjectStorage.StoredObject(contents.length,"application/json","etag");
        });
        doAnswer(invocation -> {
            byte[] contents=objects.get((String)invocation.getArgument(0));
            if(contents==null) throw new IllegalStateException("No source object.");
            Files.write(invocation.getArgument(1),contents);
            return null;
        }).when(storage).downloadTo(anyString(),any(Path.class));
        doAnswer(invocation -> {
            objects.remove((String)invocation.getArgument(0));
            return null;
        }).when(storage).delete(anyString());
    }
}
