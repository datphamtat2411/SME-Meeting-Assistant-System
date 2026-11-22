package com.sme.meetingassistant.api.transport;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.List;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Routes one explicitly named TLS peer to a literal loopback destination.
 *
 * <p>The requested host is never resolved.  It remains the SNI and hostname
 * verification identity while the TCP socket is connected only to the
 * supplied loopback address.</p>
 */
public final class LoopbackTlsSocketFactory extends SSLSocketFactory {
    private final SSLSocketFactory delegate;
    private final String connectHost;
    private final String serverName;
    private final int connectTimeoutMillis;

    public LoopbackTlsSocketFactory(
            SSLSocketFactory delegate, String connectHost, String serverName, int connectTimeoutMillis) {
        if (delegate == null || !"127.0.0.1".equals(connectHost)
                || serverName == null || !serverName.matches(
                    "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9]"
                    + "(?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*")
                || connectTimeoutMillis < 1 || connectTimeoutMillis > 30_000) {
            throw new IllegalArgumentException("Invalid isolated TLS socket route");
        }
        this.delegate = delegate;
        this.connectHost = connectHost;
        this.serverName = serverName;
        this.connectTimeoutMillis = connectTimeoutMillis;
    }

    private void requireRequestedPeer(String requested) throws IOException {
        if (!connectHost.equals(requested) && !serverName.equalsIgnoreCase(requested)) {
            throw new IOException("Unexpected TLS route");
        }
    }

    private SSLSocket configure(SSLSocket socket) {
        SSLParameters parameters = socket.getSSLParameters();
        parameters.setServerNames(List.of(new SNIHostName(serverName)));
        parameters.setEndpointIdentificationAlgorithm("HTTPS");
        socket.setSSLParameters(parameters);
        return socket;
    }

    private SSLSocket connect(String requested, int port, InetAddress local, int localPort)
            throws IOException {
        requireRequestedPeer(requested);
        if (local != null && !local.isLoopbackAddress()) {
            throw new IOException("Unexpected TLS source address");
        }
        Socket raw = new Socket();
        SSLSocket socket = null;
        try {
            if (local != null) raw.bind(new InetSocketAddress(local, localPort));
            raw.connect(new InetSocketAddress(connectHost, port), connectTimeoutMillis);
            socket = (SSLSocket) delegate.createSocket(raw, serverName, port, true);
            return configure(socket);
        } catch (IOException | RuntimeException error) {
            if (socket != null) socket.close();
            throw error;
        } finally {
            if (socket == null) raw.close();
        }
    }

    private static boolean isLoopback(Socket socket) {
        return socket.getInetAddress() != null
                && socket.getInetAddress().isLoopbackAddress();
    }

    @Override
    public Socket createSocket() throws IOException {
        try {
            // Rabbit's frame handler creates an unconnected TLS socket and
            // connects it to the resolved address itself.
            return configure((SSLSocket) delegate.createSocket());
        } catch (ClassCastException error) {
            throw new IOException("TLS provider returned a non-TLS socket", error);
        }
    }

    private SSLSocket layer(Socket socket, String requested, int port, boolean autoClose)
            throws IOException {
        requireRequestedPeer(requested);
        if (!socket.isConnected()) {
            socket.connect(new InetSocketAddress(connectHost, port), connectTimeoutMillis);
        } else if (!isLoopback(socket)) {
            socket.close();
            throw new IOException("Unexpected TLS socket destination");
        }
        try {
            return configure((SSLSocket) delegate.createSocket(socket, serverName, port, autoClose));
        } catch (ClassCastException error) {
            if (autoClose) socket.close();
            throw new IOException("TLS provider returned a non-TLS socket", error);
        } catch (RuntimeException error) {
            if (autoClose) socket.close();
            throw error;
        }
    }

    @Override
    public Socket createSocket(String host, int port) throws IOException {
        return connect(host, port, null, 0);
    }

    @Override
    public Socket createSocket(String host, int port, InetAddress local, int localPort)
            throws IOException {
        return connect(host, port, local, localPort);
    }

    @Override
    public Socket createSocket(InetAddress host, int port) throws IOException {
        return connect(host.getHostAddress(), port, null, 0);
    }

    @Override
    public Socket createSocket(
            InetAddress host, int port, InetAddress local, int localPort) throws IOException {
        return connect(host.getHostAddress(), port, local, localPort);
    }

    @Override
    public Socket createSocket(Socket socket, String host, int port, boolean autoClose)
            throws IOException {
        return layer(socket, host, port, autoClose);
    }

    @Override
    public String[] getDefaultCipherSuites() {
        return delegate.getDefaultCipherSuites();
    }

    @Override
    public String[] getSupportedCipherSuites() {
        return delegate.getSupportedCipherSuites();
    }
}
