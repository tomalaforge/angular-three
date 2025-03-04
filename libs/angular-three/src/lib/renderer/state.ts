import { ChangeDetectorRef, getDebugNode, Injector, Type } from '@angular/core';
import { NgtArgs } from '../directives/args';
import { NgtCommonDirective } from '../directives/common';
import { NgtStore } from '../stores/store';
import type { NgtAnyRecord } from '../types';
import { applyProps } from '../utils/apply-props';
import { getLocalState } from '../utils/instance';
import { is } from '../utils/is';
import { NgtCompoundClassId, NgtQueueOpClassId, NgtRendererClassId } from './enums';
import { attachThreeChild, removeThreeChild, SPECIAL_PROPERTIES } from './utils';

export type NgtRendererRootState = {
    store: NgtStore;
    cdr: ChangeDetectorRef;
    compoundPrefixes: string[];
    document: Document;
    portals: Array<NgtRendererNode>;
};

export type NgtQueueOp = [type: 'op' | 'cleanUp', op: () => void, done?: true];

export type NgtRendererState = [
    type: 'three' | 'compound' | 'portal' | 'comment' | 'dom',
    parent: NgtRendererNode | null,
    children: NgtRendererNode[],
    destroyed: boolean,
    compound: [applyFirst: boolean, props: Record<string, any>],
    compoundParent: NgtRendererNode,
    compounded: NgtRendererNode,
    queueOps: Set<NgtQueueOp>,
    attributes: Record<string, any>,
    properties: Record<string, any>,
    rawValue: any,
    ref: any,
    portalContainer: NgtRendererNode,
    injectorFactory: () => Injector
];

export type NgtRendererNode = {
    __ngt_renderer__: NgtRendererState;
};

export class NgtRendererStore {
    private readonly comments = [] as Array<NgtRendererNode>;

    constructor(private readonly root: NgtRendererRootState) {}

    createNode(type: NgtRendererState[NgtRendererClassId.type], node: NgtAnyRecord) {
        const state = [
            type,
            null,
            [],
            false,
            undefined!,
            undefined!,
            undefined!,
            undefined!,
            undefined!,
            undefined!,
            undefined!,
            undefined!,
            undefined!,
            undefined!,
        ] as NgtRendererState;

        const rendererNode = Object.assign(node, { __ngt_renderer__: state });

        // assign ownerDocument to node so we can use HostListener in Component
        if (!rendererNode['ownerDocument']) {
            rendererNode['ownerDocument'] = this.root.document;
        }

        // assign injectorFactory on non-three type since
        // rendererNode is an instance of DOM Node
        if (state[NgtRendererClassId.type] !== 'three') {
            state[NgtRendererClassId.injectorFactory] = () => getDebugNode(rendererNode)!.injector;
        }

        if (state[NgtRendererClassId.type] === 'comment') {
            // we attach an arrow function to the Comment node
            // In our directives, we can call this function to then start tracking the RendererNode
            // this is done to limit the amount of Nodes we need to process for getCreationState
            rendererNode['__ngt_renderer_add_comment__'] = (portalNode?: NgtRendererNode) => {
                if (portalNode && portalNode.__ngt_renderer__[NgtRendererClassId.type] === 'portal') {
                    this.portals.push(portalNode);
                } else {
                    this.comments.push(rendererNode);
                }
            };
            return rendererNode;
        }

        if (state[NgtRendererClassId.type] === 'compound') {
            state[NgtRendererClassId.queueOps] = new Set();
            state[NgtRendererClassId.attributes] = {};
            state[NgtRendererClassId.properties] = {};
            return rendererNode;
        }

        return rendererNode;
    }

    setParent(node: NgtRendererNode, parent: NgtRendererNode) {
        if (!node.__ngt_renderer__[NgtRendererClassId.parent]) {
            node.__ngt_renderer__[NgtRendererClassId.parent] = parent;
        }
    }

    addChild(node: NgtRendererNode, child: NgtRendererNode) {
        if (!node.__ngt_renderer__[NgtRendererClassId.children].includes(child)) {
            node.__ngt_renderer__[NgtRendererClassId.children].push(child);
        }
    }

    removeChild(node: NgtRendererNode, child: NgtRendererNode) {
        const index = node.__ngt_renderer__[NgtRendererClassId.children].findIndex((c) => child === c);
        if (index >= 0) {
            node.__ngt_renderer__[NgtRendererClassId.children].splice(index, 1);
        }
    }

    setCompound(compound: NgtRendererNode, instance: NgtRendererNode) {
        const rS = compound.__ngt_renderer__;
        rS[NgtRendererClassId.compounded] = instance;
        const attributes = Object.keys(rS[NgtRendererClassId.attributes]);
        const properties = Object.keys(rS[NgtRendererClassId.properties]);

        if (attributes.length) {
            for (const key of attributes) {
                this.applyAttribute(instance, key, rS[NgtRendererClassId.attributes][key]);
            }
        }
        if (properties.length) {
            for (const key of properties) {
                this.applyProperty(instance, key, rS[NgtRendererClassId.properties][key]);
            }
        }

        this.executeOperation(compound);
    }

    queueOperation(node: NgtRendererNode, op: NgtQueueOp) {
        node.__ngt_renderer__[NgtRendererClassId.queueOps].add(op);
    }

    executeOperation(node: NgtRendererNode, type: NgtQueueOp[NgtQueueOpClassId.type] = 'op') {
        const rS = node.__ngt_renderer__;
        if (rS[NgtRendererClassId.queueOps]?.size) {
            rS[NgtRendererClassId.queueOps].forEach((op) => {
                if (op[NgtQueueOpClassId.type] === type) {
                    op[NgtQueueOpClassId.op]();
                    rS[NgtRendererClassId.queueOps].delete(op);
                }
            });
        }
    }

    processPortalContainer(portal: NgtRendererNode) {
        const injectorFactory = portal.__ngt_renderer__[NgtRendererClassId.injectorFactory];
        const injector = injectorFactory?.();
        if (!injector) return;

        const portalStore = injector.get(NgtStore, null);
        if (!portalStore) return;

        const portalContainer = portalStore.get('scene');
        if (!portalContainer) return;

        portal.__ngt_renderer__[NgtRendererClassId.portalContainer] = this.createNode('three', portalContainer);
    }

    applyAttribute(node: NgtRendererNode, name: string, value: string) {
        const rS = node.__ngt_renderer__;
        if (rS[NgtRendererClassId.destroyed]) return;
        if (name === SPECIAL_PROPERTIES.RENDER_PRIORITY) {
            // priority needs to be set as an attribute string so that they can be set as early as possible
            // we convert that string to a number. if it's invalid, 0
            let priority = Number(value);
            if (isNaN(priority)) {
                priority = 0;
                console.warn(`[NGT] "priority" is an invalid number, default to 0`);
            }
            getLocalState(node).priority = priority;
        }

        if (name === SPECIAL_PROPERTIES.COMPOUND) {
            // we set the compound property on instance node now so we know that this instance is being compounded
            rS[NgtRendererClassId.compound] = [value === '' || value === 'first', {}];
            return;
        }

        if (name === SPECIAL_PROPERTIES.ATTACH) {
            // handle attach as tring
            const paths = value.split('.');
            if (paths.length) getLocalState(node).attach = paths;
            return;
        }

        if (name === SPECIAL_PROPERTIES.VALUE) {
            // coercion
            let maybeCoerced: any = value;
            if (maybeCoerced === '' || maybeCoerced === 'true' || maybeCoerced === 'false') {
                maybeCoerced = maybeCoerced === 'true' || maybeCoerced === '';
            } else if (!isNaN(Number(maybeCoerced))) {
                maybeCoerced = Number(maybeCoerced);
            }
            rS[NgtRendererClassId.rawValue] = maybeCoerced;
            return;
        }

        applyProps(node, { [name]: value });
    }

    applyProperty(node: NgtRendererNode, name: string, value: any) {
        const rS = node.__ngt_renderer__;
        if (rS[NgtRendererClassId.destroyed]) return;

        // [ref]
        if (name === SPECIAL_PROPERTIES.REF && is.ref(value)) {
            rS[NgtRendererClassId.ref] = value;
            value.nativeElement = node;
            return;
        }

        const parent = getLocalState(node).parent || rS[NgtRendererClassId.parent];

        // [rawValue]
        if (getLocalState(node).isRaw && name === SPECIAL_PROPERTIES.VALUE) {
            rS[NgtRendererClassId.rawValue] = value;
            if (parent) attachThreeChild(parent, node);
            return;
        }

        // [attach]
        if (name === SPECIAL_PROPERTIES.ATTACH) {
            getLocalState(node).attach = Array.isArray(value) ? value.map((v) => v.toString()) : value;
            if (parent) attachThreeChild(parent, node);
            return;
        }

        const compound = rS[NgtRendererClassId.compound];
        if (
            compound?.[NgtCompoundClassId.props] &&
            name in compound[NgtCompoundClassId.props] &&
            !compound[NgtCompoundClassId.applyFirst]
        ) {
            value = compound[NgtCompoundClassId.props][name];
        }
        applyProps(node, { [name]: value });
    }

    isCompound(name: string) {
        return this.root.compoundPrefixes.some((prefix) => name.startsWith(prefix));
    }

    isDOM(node: NgtAnyRecord) {
        const rS = node['__ngt_renderer__'];
        return (
            !rS ||
            (rS[NgtRendererClassId.type] !== 'compound' &&
                (node instanceof Element || node instanceof Document || node instanceof Window))
        );
    }

    get rootScene() {
        return this.root.store.get('scene');
    }

    get rootCdr() {
        return this.root.cdr;
    }

    get portals() {
        return this.root.portals;
    }

    getClosestParentWithInstance(node: NgtRendererNode): NgtRendererNode | null {
        let parent = node.__ngt_renderer__[NgtRendererClassId.parent];
        while (parent && parent.__ngt_renderer__[NgtRendererClassId.type] !== 'three') {
            parent = parent.__ngt_renderer__[NgtRendererClassId.portalContainer]
                ? parent.__ngt_renderer__[NgtRendererClassId.portalContainer]
                : parent.__ngt_renderer__[NgtRendererClassId.parent];
        }

        return parent;
    }

    getClosestParentWithCompound(node: NgtRendererNode) {
        if (node.__ngt_renderer__[NgtRendererClassId.compoundParent]) {
            return node.__ngt_renderer__[NgtRendererClassId.compoundParent];
        }

        let parent = node.__ngt_renderer__[NgtRendererClassId.parent];
        if (
            parent &&
            parent.__ngt_renderer__[NgtRendererClassId.type] === 'compound' &&
            !parent.__ngt_renderer__[NgtRendererClassId.compounded]
        ) {
            return parent;
        }

        while (
            parent &&
            (parent.__ngt_renderer__[NgtRendererClassId.type] === 'three' ||
                !parent.__ngt_renderer__[NgtRendererClassId.compoundParent] ||
                parent.__ngt_renderer__[NgtRendererClassId.type] !== 'compound')
        ) {
            parent = parent.__ngt_renderer__[NgtRendererClassId.parent];
        }

        if (!parent) return;

        if (
            parent.__ngt_renderer__[NgtRendererClassId.type] === 'three' &&
            parent.__ngt_renderer__[NgtRendererClassId.compoundParent]
        ) {
            return parent.__ngt_renderer__[NgtRendererClassId.compoundParent];
        }

        if (!parent.__ngt_renderer__[NgtRendererClassId.compounded]) {
            return parent;
        }

        return null;
    }

    getCreationState() {
        const injectedArgs = this.firstNonInjectedDirective(NgtArgs)?.args || [];
        const store = this.tryGetPortalStore();
        return { injectedArgs, store };
    }

    destroy(node: NgtRendererNode, parent?: NgtRendererNode) {
        const rS = node.__ngt_renderer__;
        if (rS[NgtRendererClassId.destroyed]) return;
        if (rS[NgtRendererClassId.type] === 'three') {
            rS[NgtRendererClassId.compound] = undefined!;
            rS[NgtRendererClassId.compoundParent] = undefined!;

            const localState = getLocalState(node);
            if (localState.objects) {
                localState.objects.value.forEach((obj) => this.destroy(obj, parent));
                localState.objects.complete();
            }

            if (localState.nonObjects) {
                localState.nonObjects.value.forEach((obj) => this.destroy(obj, parent));
                localState.nonObjects.complete();
            }

            if (localState.afterUpdate) localState.afterUpdate.complete();
            if (localState.afterAttach) localState.afterAttach.complete();

            delete (localState as NgtAnyRecord)['objects'];
            delete (localState as NgtAnyRecord)['nonObjects'];
            delete (localState as NgtAnyRecord)['add'];
            delete (localState as NgtAnyRecord)['remove'];
            delete (localState as NgtAnyRecord)['afterUpdate'];
            delete (localState as NgtAnyRecord)['afterAttach'];
            delete (localState as NgtAnyRecord)['store'];
            delete (localState as NgtAnyRecord)['handlers'];

            if (!localState.primitive) {
                delete (node as NgtAnyRecord)['__ngt__'];
            }
        }

        if (rS[NgtRendererClassId.type] === 'comment') {
            rS[NgtRendererClassId.injectorFactory] = null!;
            delete (node as NgtAnyRecord)['__ngt_renderer_add_comment__'];
            const index = this.comments.findIndex((comment) => comment === node);
            if (index > -1) {
                this.comments.splice(index, 1);
            }
        }

        if (rS[NgtRendererClassId.type] === 'portal') {
            rS[NgtRendererClassId.injectorFactory] = null!;
            const index = this.portals.findIndex((portal) => portal === node);
            if (index > -1) {
                this.portals.splice(index, 1);
            }
        }

        if (rS[NgtRendererClassId.type] === 'compound') {
            rS[NgtRendererClassId.compounded] = undefined!;
            rS[NgtRendererClassId.attributes] = null!;
            rS[NgtRendererClassId.properties] = null!;
            this.executeOperation(node, 'cleanUp');
            rS[NgtRendererClassId.queueOps].clear();
            rS[NgtRendererClassId.queueOps] = null!;
        }

        if (rS[NgtRendererClassId.ref]) {
            // nullify ref
            rS[NgtRendererClassId.ref].nativeElement = null;
            rS[NgtRendererClassId.ref] = undefined!;
        }

        // nullify parent
        rS[NgtRendererClassId.parent] = null;
        for (const renderChild of rS[NgtRendererClassId.children] || []) {
            if (renderChild.__ngt_renderer__[NgtRendererClassId.type] === 'three' && parent) {
                removeThreeChild(parent, renderChild, true);
            }
            this.destroy(renderChild, parent);
        }

        rS[NgtRendererClassId.children] = [];
        rS[NgtRendererClassId.destroyed] = true;
        if (parent) {
            this.removeChild(parent, node);
        }
    }

    private firstNonInjectedDirective<T extends NgtCommonDirective>(dir: Type<T>) {
        let directive: T | undefined;

        let i = this.comments.length - 1;
        while (i >= 0) {
            const comment = this.comments[i];
            if (comment.__ngt_renderer__[NgtRendererClassId.destroyed]) {
                i--;
                continue;
            }
            const injector = comment.__ngt_renderer__[NgtRendererClassId.injectorFactory]();
            if (!injector) {
                i--;
                continue;
            }
            const instance = injector.get(dir, null);
            if (instance && instance.validate()) {
                directive = instance;
                break;
            }

            i--;
        }

        return directive;
    }

    private tryGetPortalStore() {
        let store: NgtStore | undefined;
        // we only care about the portal states because NgtStore only differs per Portal
        let i = this.portals.length - 1;
        while (i >= 0) {
            // loop through the portal state backwards to find the closest NgtStore
            const portal = this.portals[i];
            if (portal.__ngt_renderer__[NgtRendererClassId.destroyed]) {
                i--;
                continue;
            }

            const injector = portal.__ngt_renderer__[NgtRendererClassId.injectorFactory]();
            if (!injector) {
                i--;
                continue;
            }
            const instance = injector.get(NgtStore, null);
            // only the instance with previousStore should pass
            if (instance && instance.get('previousStore')) {
                store = instance;
                break;
            }
            i--;
        }
        return store || this.root!.store;
    }
}
