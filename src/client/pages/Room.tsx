import { useSync } from '@tldraw/sync'
import {
    AssetRecordType,
    getHashForString,
    TLAssetStore,
    TLBookmarkAsset,
    Tldraw,
    uniqueId,
} from 'tldraw'
import { useTldrawUser } from '@tldraw/editor'
import {getAssetUrlsByMetaUrl} from '@tldraw/assets/urls'
import { useParams } from 'react-router-dom'
import { ReactNode, useEffect, useState } from 'react'

const assetUrls = getAssetUrlsByMetaUrl();

let WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:5858';
if(import.meta.env.MODE === 'production') {
    WORKER_URL = window.location.origin;
}

const USER_COLORS = ['#ff5d5d', '#ff8b5d', '#ffc65d', '#8bd05d', '#5dd0a3', '#5da7d0', '#5d7fd0', '#a35dd0', '#d05db4']

function pickColor(name: string) {
    let h = 0
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return USER_COLORS[h % USER_COLORS.length]
}

function getDeviceLabel(): string {
    const ua = navigator.userAgent
    if (/iPad/i.test(ua)) return 'iPad'
    if (/iPhone|iPod/i.test(ua)) return 'iPhone'
    if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android' : 'Android-Tablet'
    if (/Mac OS X/i.test(ua)) return 'Mac'
    if (/Windows/i.test(ua)) return 'Windows'
    if (/Linux/i.test(ua)) return 'Linux'
    return 'Gerät'
}

function getDeviceId(): string {
    const existing = sessionStorage.getItem('tldraw-device-id')
    if (existing) return existing
    const id = `dev-${Math.random().toString(36).slice(2, 10)}`
    sessionStorage.setItem('tldraw-device-id', id)
    return id
}

type Me = { user: string | null; name: string | null } | null

export function Room() {
    const { roomId } = useParams<{ roomId: string }>()
    const [me, setMe] = useState<Me>(null)
    const [deviceId] = useState(getDeviceId)
    const [deviceLabel] = useState(getDeviceLabel)

    useEffect(() => {
        let cancelled = false
        fetch(`${WORKER_URL}/api/me`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((data) => {
                if (!cancelled) setMe({ user: data?.user ?? null, name: data?.name ?? null })
            })
            .catch(() => {
                if (!cancelled) setMe({ user: null, name: null })
            })
        return () => {
            cancelled = true
        }
    }, [])

    const userName = me?.name ? `${me.name} · ${deviceLabel}` : 'Gast'
    const userId = me?.user ? `${me.user}:${deviceId}` : deviceId
    const userColor = pickColor(userName)

    // Create a store connected to multiplayer.
    const store = useSync({
        // We need to know the websocket's URI...
        uri: `${WORKER_URL}/api/connect/${roomId}`,
        // ...how to handle static assets like images & videos
        assets: multiplayerAssets,
        // A unique presence id per tab so the same person on multiple devices
        // stays clearly separated. Must match the user passed to <Tldraw>.
        userInfo: { id: userId, name: userName, color: userColor },
    })

    const user = useTldrawUser({
        userPreferences: {
            id: userId,
            name: userName,
            color: userColor,
        },
    })

    return (
        <RoomWrapper roomId={roomId}>
            {me ? (
                <Tldraw
                    // we can pass the connected store into the Tldraw component which will handle
                    // loading states & enable multiplayer UX like cursors & a presence menu
                    store={store}
                    assetUrls={assetUrls}
                    deepLinks
                    user={user}
                    onMount={(editor) => {
                        // @ts-expect-error
                        window.editor = editor
                        // when the editor is ready, we need to register out bookmark unfurling service
                        editor.registerExternalAssetHandler('url', unfurlBookmarkUrl)
                    }}
                />
            ) : (
                <div className="RoomWrapper-content">
                    <p>Lade …</p>
                </div>
            )}
        </RoomWrapper>
    )
}

function RoomWrapper({ children, roomId }: { children: ReactNode; roomId?: string }) {
	const [didCopy, setDidCopy] = useState(false)

	useEffect(() => {
		if (!didCopy) return
		const timeout = setTimeout(() => setDidCopy(false), 3000)
		return () => clearTimeout(timeout)
	}, [didCopy])

	return (
		<div className="RoomWrapper">
			<div className="RoomWrapper-header">
				<WifiIcon />
				<div>{roomId}</div>
				<button
					className="RoomWrapper-copy"
					onClick={() => {
						navigator.clipboard.writeText(window.location.href)
						setDidCopy(true)
					}}
					aria-label="copy room link"
				>
					Copy link
					{didCopy && <div className="RoomWrapper-copied">Copied!</div>}
				</button>
			</div>
			<div className="RoomWrapper-content">{children}</div>
		</div>
	)
}


// How does our server handle assets like images and videos?
const multiplayerAssets: TLAssetStore = {
    // to upload an asset, we prefix it with a unique id, POST it to our worker, and return the URL
    async upload(_asset, file) {
        const id = uniqueId()

        const objectName = `${id}-${file.name}`
        const url = `${WORKER_URL}/api/uploads/${encodeURIComponent(objectName)}`

        const response = await fetch(url, {
            method: 'PUT',
            body: file,
        })

        if (!response.ok) {
            throw new Error(`Failed to upload asset: ${response.statusText}`)
        }

        return { src: url }
    },
    // to retrieve an asset, we can just use the same URL. you could customize this to add extra
    // auth, or to serve optimized versions / sizes of the asset.
    resolve(asset) {
        return asset.props.src
    },
}

// How does our server handle bookmark unfurling?
async function unfurlBookmarkUrl({ url }: { url: string }): Promise<TLBookmarkAsset> {
    const asset: TLBookmarkAsset = {
        id: AssetRecordType.createId(getHashForString(url)),
        typeName: 'asset',
        type: 'bookmark',
        meta: {},
        props: {
            src: url,
            description: '',
            image: '',
            favicon: '',
            title: '',
        },
    }

    try {
        const response = await fetch(`${WORKER_URL}/api/unfurl?url=${encodeURIComponent(url)}`)
        const data = await response.json()

        asset.props.description = data?.description ?? ''
        asset.props.image = data?.image ?? ''
        asset.props.favicon = data?.favicon ?? ''
        asset.props.title = data?.title ?? ''
    } catch (e) {
        console.error(e)
    }

    return asset
}

function WifiIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
			strokeWidth="1.5"
			stroke="currentColor"
			width={16}
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z"
			/>
		</svg>
	)
}