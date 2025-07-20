const CACHE_NAME = 'videohub-v1.2.0';
const STATIC_CACHE = `${CACHE_NAME}-static`;
const DYNAMIC_CACHE = `${CACHE_NAME}-dynamic`;
const IMAGE_CACHE = `${CACHE_NAME}-images`;

// Assets to cache immediately
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// Assets to cache on first request
const CACHE_ON_REQUEST = [
    '/offline.html'
];

// Maximum cache size for dynamic content
const MAX_CACHE_SIZE = 50;

// Cache strategies
const CACHE_STRATEGIES = {
    CACHE_FIRST: 'cache-first',
    NETWORK_FIRST: 'network-first',
    STALE_WHILE_REVALIDATE: 'stale-while-revalidate',
    NETWORK_ONLY: 'network-only',
    CACHE_ONLY: 'cache-only'
};

// Install event - cache static assets
self.addEventListener('install', event => {
    console.log('SW: Installing...');
    
    event.waitUntil(
        Promise.all([
            caches.open(STATIC_CACHE).then(cache => {
                console.log('SW: Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            }),
            caches.open(DYNAMIC_CACHE),
            caches.open(IMAGE_CACHE)
        ]).then(() => {
            console.log('SW: Installation complete');
            return self.skipWaiting();
        }).catch(error => {
            console.error('SW: Installation failed', error);
        })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
    console.log('SW: Activating...');
    
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (!cacheName.startsWith(CACHE_NAME)) {
                        console.log('SW: Deleting old cache', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            console.log('SW: Activation complete');
            return self.clients.claim();
        })
    );
});

// Fetch event - handle all network requests
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    
    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }
    
    // Handle different types of requests
    if (request.destination === 'image') {
        event.respondWith(handleImageRequest(request));
    } else if (url.origin === location.origin) {
        event.respondWith(handleSameOriginRequest(request));
    } else if (isCDNResource(url)) {
        event.respondWith(handleCDNRequest(request));
    } else {
        event.respondWith(handleExternalRequest(request));
    }
});

// Handle image requests with cache-first strategy
async function handleImageRequest(request) {
    try {
        const cache = await caches.open(IMAGE_CACHE);
        const cachedResponse = await cache.match(request);
        
        if (cachedResponse) {
            return cachedResponse;
        }
        
        const networkResponse = await fetch(request);
        
        if (networkResponse.ok) {
            // Clone response before caching
            const responseClone = networkResponse.clone();
            await cache.put(request, responseClone);
            await limitCacheSize(IMAGE_CACHE, MAX_CACHE_SIZE);
        }
        
        return networkResponse;
    } catch (error) {
        console.log('SW: Image request failed', error);
        return createErrorResponse('Image not available offline');
    }
}

// Handle same-origin requests
async function handleSameOriginRequest(request) {
    const url = new URL(request.url);
    
    // Handle root and index.html with network-first strategy
    if (url.pathname === '/' || url.pathname === '/index.html') {
        return handleWithStrategy(request, CACHE_STRATEGIES.NETWORK_FIRST, STATIC_CACHE);
    }
    
    // Handle static assets with cache-first strategy
    if (isStaticAsset(url.pathname)) {
        return handleWithStrategy(request, CACHE_STRATEGIES.CACHE_FIRST, STATIC_CACHE);
    }
    
    // Handle dynamic content with stale-while-revalidate
    return handleWithStrategy(request, CACHE_STRATEGIES.STALE_WHILE_REVALIDATE, DYNAMIC_CACHE);
}

// Handle CDN requests (fonts, libraries)
async function handleCDNRequest(request) {
    return handleWithStrategy(request, CACHE_STRATEGIES.STALE_WHILE_REVALIDATE, STATIC_CACHE);
}

// Handle external requests
async function handleExternalRequest(request) {
    try {
        const response = await fetch(request);
        return response;
    } catch (error) {
        console.log('SW: External request failed', error);
        return createErrorResponse('External resource not available');
    }
}

// Generic strategy handler
async function handleWithStrategy(request, strategy, cacheName) {
    const cache = await caches.open(cacheName);
    
    switch (strategy) {
        case CACHE_STRATEGIES.CACHE_FIRST:
            return handleCacheFirst(request, cache);
        
        case CACHE_STRATEGIES.NETWORK_FIRST:
            return handleNetworkFirst(request, cache);
        
        case CACHE_STRATEGIES.STALE_WHILE_REVALIDATE:
            return handleStaleWhileRevalidate(request, cache);
        
        case CACHE_STRATEGIES.CACHE_ONLY:
            return cache.match(request) || createErrorResponse('Content not available offline');
        
        case CACHE_STRATEGIES.NETWORK_ONLY:
            return fetch(request);
        
        default:
            return handleNetworkFirst(request, cache);
    }
}

// Cache-first strategy
async function handleCacheFirst(request, cache) {
    try {
        const cachedResponse = await cache.match(request);
        
        if (cachedResponse) {
            return cachedResponse;
        }
        
        const networkResponse = await fetch(request);
        
        if (networkResponse.ok) {
            await cache.put(request, networkResponse.clone());
            await limitCacheSize(cache, MAX_CACHE_SIZE);
        }
        
        return networkResponse;
    } catch (error) {
        const cachedResponse = await cache.match(request);
        return cachedResponse || createOfflineResponse(request);
    }
}

// Network-first strategy
async function handleNetworkFirst(request, cache) {
    try {
        const networkResponse = await fetch(request);
        
        if (networkResponse.ok) {
            await cache.put(request, networkResponse.clone());
            await limitCacheSize(cache, MAX_CACHE_SIZE);
        }
        
        return networkResponse;
    } catch (error) {
        const cachedResponse = await cache.match(request);
        return cachedResponse || createOfflineResponse(request);
    }
}

// Stale-while-revalidate strategy
async function handleStaleWhileRevalidate(request, cache) {
    const cachedResponse = await cache.match(request);
    
    // Start network request (don't await)
    const networkPromise = fetch(request).then(response => {
        if (response.ok) {
            cache.put(request, response.clone());
            limitCacheSize(cache, MAX_CACHE_SIZE);
        }
        return response;
    }).catch(error => {
        console.log('SW: Network request failed during revalidation', error);
    });
    
    // Return cached response immediately if available
    if (cachedResponse) {
        return cachedResponse;
    }
    
    // Wait for network if no cached response
    try {
        return await networkPromise;
    } catch (error) {
        return createOfflineResponse(request);
    }
}

// Utility functions
function isStaticAsset(pathname) {
    const staticExtensions = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2'];
    return staticExtensions.some(ext => pathname.endsWith(ext));
}

function isCDNResource(url) {
    const cdnDomains = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
    return cdnDomains.some(domain => url.hostname.includes(domain));
}

async function limitCacheSize(cache, maxSize) {
    if (typeof cache === 'string') {
        cache = await caches.open(cache);
    }
    
    const keys = await cache.keys();
    
    if (keys.length > maxSize) {
        const keysToDelete = keys.slice(0, keys.length - maxSize);
        await Promise.all(keysToDelete.map(key => cache.delete(key)));
    }
}

function createErrorResponse(message) {
    return new Response(
        JSON.stringify({ error: message }),
        {
            status: 503,
            statusText: 'Service Unavailable',
            headers: {
                'Content-Type': 'application/json'
            }
        }
    );
}

function createOfflineResponse(request) {
    const url = new URL(request.url);
    
    // Return offline page for navigation requests
    if (request.mode === 'navigate') {
        return caches.match('/') || new Response(
            createOfflineHTML(),
            {
                headers: {
                    'Content-Type': 'text/html'
                }
            }
        );
    }
    
    // Return appropriate offline response for other requests
    return createErrorResponse('Content not available offline');
}

function createOfflineHTML() {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>VideoHub - Offline</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                text-align: center;
                padding: 2rem;
            }
            
            .offline-icon {
                font-size: 4rem;
                margin-bottom: 2rem;
                opacity: 0.8;
            }
            
            h1 {
                font-size: 2rem;
                margin-bottom: 1rem;
                font-weight: 300;
            }
            
            p {
                font-size: 1.1rem;
                margin-bottom: 2rem;
                opacity: 0.9;
                max-width: 400px;
                line-height: 1.6;
            }
            
            .retry-btn {
                background: rgba(255, 255, 255, 0.2);
                border: 2px solid rgba(255, 255, 255, 0.3);
                color: white;
                padding: 0.75rem 2rem;
                border-radius: 50px;
                font-size: 1rem;
                cursor: pointer;
                transition: all 0.3s ease;
            }
            
            .retry-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: translateY(-2px);
            }
        </style>
    </head>
    <body>
        <div class="offline-icon">📱</div>
        <h1>You're Offline</h1>
        <p>VideoHub is not available right now. Check your connection and try again.</p>
        <button class="retry-btn" onclick="window.location.reload()">Try Again</button>
        
        <script>
            // Auto-retry when connection is restored
            window.addEventListener('online', () => {
                window.location.reload();
            });
        </script>
    </body>
    </html>
    `;
}

// Background sync for future enhancement
self.addEventListener('sync', event => {
    console.log('SW: Background sync triggered', event.tag);
    
    if (event.tag === 'background-sync') {
        event.waitUntil(handleBackgroundSync());
    }
});

async function handleBackgroundSync() {
    try {
        // Handle queued actions when connection is restored
        console.log('SW: Performing background sync');
        
        // This could include:
        // - Uploading queued videos
        // - Syncing user preferences
        // - Downloading new content
        
        return Promise.resolve();
    } catch (error) {
        console.error('SW: Background sync failed', error);
        throw error;
    }
}

// Push notifications for future enhancement
self.addEventListener('push', event => {
    if (!event.data) return;
    
    const data = event.data.json();
    const options = {
        body: data.body || 'New content available!',
        icon: '/icon-192x192.png',
        badge: '/badge-72x72.png',
        tag: 'videohub-notification',
        data: data.url || '/',
        actions: [
            {
                action: 'view',
                title: 'View',
                icon: '/icon-view.png'
            },
            {
                action: 'dismiss',
                title: 'Dismiss'
            }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title || 'VideoHub', options)
    );
});

// Notification click handler
self.addEventListener('notificationclick', event => {
    event.notification.close();
    
    const action = event.action;
    const url = event.notification.data || '/';
    
    if (action === 'dismiss') {
        return;
    }
    
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(clientList => {
            // Focus existing window if available
            for (const client of clientList) {
                if (client.url === url && 'focus' in client) {
                    return client.focus();
                }
            }
            
            // Open new window
            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});

// Message handling for communication with main thread
self.addEventListener('message', event => {
    const { type, payload } = event.data;
    
    switch (type) {
        case 'SKIP_WAITING':
            self.skipWaiting();
            break;
        
        case 'GET_VERSION':
            event.ports[0].postMessage({ version: CACHE_NAME });
            break;
        
        case 'CLEAR_CACHE':
            clearAllCaches().then(() => {
                event.ports[0].postMessage({ success: true });
            });
            break;
        
        default:
            console.log('SW: Unknown message type', type);
    }
});

async function clearAllCaches() {
    const cacheNames = await caches.keys();
    return Promise.all(cacheNames.map(name => caches.delete(name)));
}

console.log('SW: Service Worker loaded successfully');
