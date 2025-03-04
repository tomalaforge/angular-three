import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { selectSlice } from '@rx-angular/state';
import * as THREE from 'three';
import { createLoop } from '../loop';
import type {
    NgtBeforeRenderRecord,
    NgtCanvasInputs,
    NgtDpr,
    NgtEquConfig,
    NgtEventManager,
    NgtSize,
    NgtState,
    NgtViewport,
} from '../types';
import { applyProps } from '../utils/apply-props';
import { prepare } from '../utils/instance';
import { is } from '../utils/is';
import { makeDefaultCamera, makeDefaultRenderer, makeDpr } from '../utils/make';
import { checkNeedsUpdate, updateCamera } from '../utils/update';
import { NgtRxStore } from './rx-store';

export const rootStateMap = new Map<Element, NgtRxStore<NgtState>>();
const { invalidate, advance } = createLoop(rootStateMap);
const shallowLoose = { objects: 'shallow', strict: false } as NgtEquConfig;

@Injectable()
export class NgtStore extends NgtRxStore<NgtState> {
    private readonly parentStore = inject(NgtStore, { optional: true, skipSelf: true });
    private readonly window = inject(DOCUMENT).defaultView as Window & typeof globalThis;

    isInit = false;

    init() {
        if (!this.isInit) {
            const position = new THREE.Vector3();
            const defaultTarget = new THREE.Vector3();
            const tempTarget = new THREE.Vector3();

            const getCurrentViewport = (
                camera = this.get('camera'),
                target: THREE.Vector3 | Parameters<THREE.Vector3['set']> = defaultTarget,
                size = this.get('size')
            ): Omit<NgtViewport, 'dpr' | 'initialDpr'> => {
                const { width, height, top, left } = size;
                const aspect = width / height;
                if (target instanceof THREE.Vector3) tempTarget.copy(target);
                else tempTarget.set(...target);

                const distance = camera.getWorldPosition(position).distanceTo(tempTarget);

                if (is.orthographicCamera(camera)) {
                    return {
                        width: width / camera.zoom,
                        height: height / camera.zoom,
                        top,
                        left,
                        factor: 1,
                        distance,
                        aspect,
                    };
                }

                const fov = (camera.fov * Math.PI) / 180; // convert vertical fov to radians
                const h = 2 * Math.tan(fov / 2) * distance; // visible height
                const w = h * aspect;
                return { width: w, height: h, top, left, factor: width / w, distance, aspect };
            };

            const pointer = new THREE.Vector2();

            let performanceTimeout: ReturnType<typeof setTimeout>;
            const setPerformanceCurrent = (current: number) => {
                this.set((state) => ({ performance: { ...state.performance, current } }));
            };

            this.set({
                get: this.get.bind(this),
                set: this.set.bind(this),
                select: this.select.bind(this),
                ready: false,

                scene: prepare(new THREE.Scene(), { store: this }),
                events: { priority: 1, enabled: true, connected: false },

                invalidate: (frames = 1) => invalidate(this, frames),
                advance: (timestamp: number, runGlobalEffects?: boolean) => advance(timestamp, runGlobalEffects, this),

                legacy: false,
                linear: false,
                flat: false,

                controls: null,
                clock: new THREE.Clock(),
                pointer,

                frameloop: 'always',
                performance: {
                    current: 1,
                    min: 0.5,
                    max: 1,
                    debounce: 200,
                    regress: () => {
                        const state = this.get();
                        // clear timeout
                        if (performanceTimeout) clearTimeout(performanceTimeout);
                        // set lower bound
                        if (state.performance.current !== state.performance.min) {
                            setPerformanceCurrent(state.performance.min);
                        }
                        // go back to upper bound
                        performanceTimeout = setTimeout(
                            () => setPerformanceCurrent(this.get('performance', 'max') || 1),
                            state.performance.debounce
                        );
                    },
                },
                size: { width: 0, height: 0, top: 0, left: 0 },
                viewport: {
                    initialDpr: 0,
                    dpr: 0,
                    width: 0,
                    height: 0,
                    top: 0,
                    left: 0,
                    aspect: 0,
                    distance: 0,
                    factor: 0,
                    getCurrentViewport,
                },
                previousStore: this.parentStore as NgtRxStore<NgtState>,
                internal: {
                    active: false,
                    priority: 0,
                    frames: 0,
                    lastEvent: null!,
                    interaction: [],
                    hovered: new Map(),
                    subscribers: [],
                    initialClick: [0, 0],
                    initialHits: [],
                    capturedMap: new Map(),
                    subscribe: (callback: NgtBeforeRenderRecord['callback'], priority = 0, store = this) => {
                        const internal = this.get('internal');
                        // If this subscription was given a priority, it takes rendering into its own hands
                        // For that reason we switch off automatic rendering and increase the manual flag
                        // As long as this flag is positive there can be no internal rendering at all
                        // because there could be multiple render subscriptions
                        internal.priority = internal.priority + (priority > 0 ? 1 : 0);
                        internal.subscribers.push({ priority, store, callback });
                        // Register subscriber and sort layers from lowest to highest, meaning,
                        // highest priority renders last (on top of the other frames)
                        internal.subscribers.sort((a, b) => (a.priority || 0) - (b.priority || 0));

                        return () => {
                            const internal = this.get('internal');
                            if (internal?.subscribers) {
                                // Decrease manual flag if this subscription had a priority
                                internal.priority = internal.priority - (priority > 0 ? 1 : 0);
                                // Remove subscriber from list
                                internal.subscribers = internal.subscribers.filter((s) => s.callback !== callback);
                            }
                        };
                    },
                },
                setEvents: (events: Partial<NgtEventManager>) => {
                    this.set((state) => ({ events: { ...state.events, ...events } }));
                },
                setSize: (width: number, height: number, top?: number, left?: number) => {
                    const camera = this.get('camera');
                    const size = { width, height, top: top || 0, left: left || 0 };

                    this.set((state) => ({
                        size,
                        viewport: { ...state.viewport, ...getCurrentViewport(camera, defaultTarget, size) },
                    }));
                },
                setDpr: (dpr: NgtDpr) => {
                    const resolved = makeDpr(dpr, this.window);
                    this.set((state) => ({
                        viewport: {
                            ...state.viewport,
                            dpr: resolved,
                            initialDpr: state.viewport.initialDpr || resolved,
                        },
                    }));
                },
                setFrameloop: (frameloop: 'always' | 'demand' | 'never' = 'always') => {
                    const clock = this.get('clock');
                    clock.stop();
                    clock.elapsedTime = 0;

                    if (frameloop !== 'never') {
                        clock.start();
                        clock.elapsedTime = 0;
                    }

                    this.set({ frameloop });
                },
                addInteraction: (interaction) => {
                    this.set((state) => ({
                        internal: { ...state.internal, interaction: [...state.internal.interaction, interaction] },
                    }));
                },
                removeInteraction: (uuid) => {
                    this.set((state) => ({
                        internal: {
                            ...state.internal,
                            interaction: state.internal.interaction.filter((interaction) => interaction.uuid !== uuid),
                        },
                    }));
                },
            });

            this.isInit = true;
            this.resize();
        }
    }

    configure(inputs: NgtCanvasInputs, canvasElement: HTMLCanvasElement) {
        const {
            gl: glOptions,
            size: sizeOptions,
            camera: cameraOptions,
            raycaster: raycasterOptions,
            events,
            orthographic,
            lookAt,
            shadows,
            linear,
            legacy,
            flat,
            dpr,
            frameloop,
            performance,
        } = inputs;

        const state = this.get();
        const stateToUpdate: Partial<NgtState> = {};

        // setup renderer
        let gl = state.gl;
        if (!state.gl) {
            stateToUpdate.gl = gl = makeDefaultRenderer(glOptions, canvasElement);
        }

        // setup raycaster
        let raycaster = state.raycaster;
        if (!raycaster) {
            stateToUpdate.raycaster = raycaster = new THREE.Raycaster();
        }

        // set raycaster options
        const { params, ...options } = raycasterOptions || {};
        if (!is.equ(options, raycaster, shallowLoose)) applyProps(raycaster, { ...options });
        if (!is.equ(params, raycaster.params, shallowLoose)) {
            applyProps(raycaster, { params: { ...raycaster.params, ...(params || {}) } });
        }

        // create default camera
        if (!state.camera) {
            const isCamera = is.camera(cameraOptions);
            let camera = isCamera ? cameraOptions : makeDefaultCamera(orthographic || false, state.size);

            if (!isCamera) {
                if (cameraOptions) applyProps(camera, cameraOptions);

                // set position.z
                if (!cameraOptions?.position) camera.position.z = 5;

                // always look at center or passed-in lookAt by default
                if (!cameraOptions?.rotation) {
                    if (Array.isArray(lookAt)) camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
                    else if (lookAt instanceof THREE.Vector3) camera.lookAt(lookAt);
                    else camera.lookAt(0, 0, 0);
                }

                // update projection matrix after applyprops
                camera.updateProjectionMatrix();
            }

            if (!is.instance(camera)) camera = prepare(camera, { store: this });

            stateToUpdate.camera = camera;
        }

        // Set up XR (one time only!)
        if (!state.xr) {
            // Handle frame behavior in WebXR
            const handleXRFrame: XRFrameRequestCallback = (timestamp: number, frame?: XRFrame) => {
                const state = this.get();
                if (state.frameloop === 'never') return;
                advance(timestamp, true, this, frame);
            };

            // Toggle render switching on session
            const handleSessionChange = () => {
                const state = this.get();
                state.gl.xr.enabled = state.gl.xr.isPresenting;

                state.gl.xr.setAnimationLoop(state.gl.xr.isPresenting ? handleXRFrame : null);
                if (!state.gl.xr.isPresenting) invalidate(this);
            };

            // WebXR session manager
            const xr = {
                connect: () => {
                    gl.xr.addEventListener('sessionstart', handleSessionChange);
                    gl.xr.addEventListener('sessionend', handleSessionChange);
                },
                disconnect: () => {
                    gl.xr.removeEventListener('sessionstart', handleSessionChange);
                    gl.xr.removeEventListener('sessionend', handleSessionChange);
                },
            };

            // Subscribe to WebXR session events
            if (gl.xr) xr.connect();
            stateToUpdate.xr = xr;
        }

        // Set shadowmap
        if (gl.shadowMap) {
            const isBoolean = typeof shadows === 'boolean';
            if ((isBoolean && gl.shadowMap.enabled !== shadows) || !is.equ(shadows, gl.shadowMap, shallowLoose)) {
                const old = gl.shadowMap.enabled;
                gl.shadowMap.enabled = !!shadows;
                if (!isBoolean) Object.assign(gl.shadowMap, shadows);
                else gl.shadowMap.type = THREE.PCFSoftShadowMap;

                if (old !== gl.shadowMap.enabled) checkNeedsUpdate(gl.shadowMap);
            }
        }

        // Safely set color management if available.
        // Avoid accessing THREE.ColorManagement to play nice with older versions
        if (THREE.ColorManagement) THREE.ColorManagement.legacyMode = legacy ?? true;
        const outputEncoding = linear ? THREE.LinearEncoding : THREE.sRGBEncoding;
        const toneMapping = flat ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;

        if (gl.outputEncoding !== outputEncoding) gl.outputEncoding = outputEncoding;
        if (gl.toneMapping !== toneMapping) gl.toneMapping = toneMapping;

        // Update color management state
        if (state.legacy !== legacy) stateToUpdate.legacy = legacy;
        if (state.linear !== linear) stateToUpdate.linear = linear;
        if (state.flat !== flat) stateToUpdate.flat = flat;

        // Set gl props
        gl.setClearAlpha(0);
        gl.setPixelRatio(makeDpr(state.viewport.dpr));
        gl.setSize(state.size.width, state.size.height);

        if (
            is.obj(glOptions) &&
            !(typeof glOptions === 'function') &&
            !is.renderer(glOptions) &&
            !is.equ(glOptions, gl, shallowLoose)
        ) {
            applyProps(gl, glOptions);
        }

        // Store events internally
        if (events && !state.events.handlers) stateToUpdate.events = events(this);

        // Check performance
        if (performance && !is.equ(performance, state.performance, shallowLoose)) {
            stateToUpdate.performance = { ...state.performance, ...performance };
        }

        this.set(stateToUpdate);

        // Check pixelratio
        if (dpr && state.viewport.dpr !== makeDpr(dpr)) state.setDpr(dpr);
        // Check size, allow it to take on container bounds initially
        const size = computeInitialSize(canvasElement, sizeOptions);
        if (!is.equ(size, state.size, shallowLoose)) state.setSize(size.width, size.height, size.top, size.left);

        // Check frameloop
        if (state.frameloop !== frameloop) state.setFrameloop(frameloop);

        if (!this.get('ready')) this.set({ ready: true });

        this.invalidate();
    }

    private resize() {
        const state = this.get();
        let oldSize = state.size;
        let oldDpr = state.viewport.dpr;
        let oldCamera = state.camera;

        this.hold(this.select(selectSlice(['camera', 'size', 'viewport', 'gl'])), () => {
            const { camera, size, viewport, gl, set } = this.get();
            // resize camera and renderer on changes to size and dpr
            if (size !== oldSize || viewport.dpr !== oldDpr) {
                oldSize = size;
                oldDpr = viewport.dpr;
                // update camera
                updateCamera(camera, size);
                gl.setPixelRatio(viewport.dpr);
                gl.setSize(size.width, size.height);
            }

            // update viewport when camera changes
            if (camera !== oldCamera) {
                updateCamera(camera, size);
                oldCamera = camera;
                set((state) => ({ viewport: { ...state.viewport, ...state.viewport.getCurrentViewport(camera) } }));
            }
        });
    }

    private invalidate() {
        this.hold(this.select(), () => invalidate(this));
    }
}

function computeInitialSize(canvas: HTMLCanvasElement | THREE.OffscreenCanvas, defaultSize?: NgtSize): NgtSize {
    if (defaultSize) {
        return defaultSize;
    }

    if (canvas instanceof HTMLCanvasElement && canvas.parentElement) {
        const { width, height, top, left } = canvas.parentElement.getBoundingClientRect();
        return { width, height, top, left };
    }

    return { width: 0, height: 0, top: 0, left: 0 };
}
