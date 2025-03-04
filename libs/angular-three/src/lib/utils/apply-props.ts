import * as THREE from 'three';
import type { NgtAnyRecord, NgtInstanceNode } from '../types';
import { getLocalState, invalidateInstance } from './instance';
import { is } from './is';
import { checkUpdate } from './update';

function diffProps(instance: NgtAnyRecord, props: NgtAnyRecord) {
    const propsEntries = Object.entries(props);
    const changes: [key: string, value: unknown][] = [];

    for (const [propKey, propValue] of propsEntries) {
        if (is.equ(propValue, instance[propKey])) continue;
        changes.push([propKey, propValue]);
    }

    return changes;
}

export function applyProps(instance: NgtInstanceNode, props: NgtAnyRecord): NgtInstanceNode {
    // if props is empty
    if (!Object.keys(props).length) return instance;

    // filter equals, events , and reserved props
    const localState = getLocalState(instance);
    const rootState = localState.store?.get();
    const changes = diffProps(instance, props);

    for (let i = 0; i < changes.length; i++) {
        const key = changes[i][0];
        const currentInstance = instance;
        const targetProp = currentInstance[key] as NgtAnyRecord;
        const value = changes[i][1];

        // special treatmen for objects with support for set/copy, and layers
        if (targetProp && targetProp['set'] && (targetProp['copy'] || targetProp instanceof THREE.Layers)) {
            const isColor = targetProp instanceof THREE.Color;
            // if value is an array
            if (Array.isArray(value)) {
                if (targetProp['fromArray']) targetProp['fromArray'](value);
                else targetProp['set'](...value);
            }
            // test again target.copy
            else if (
                targetProp['copy'] &&
                value &&
                value.constructor &&
                targetProp.constructor.name === value.constructor.name
            ) {
                targetProp['copy'](value);
                if (!THREE.ColorManagement && !rootState.linear && isColor) targetProp['convertSRGBToLinear']();
            }
            // if nothing else fits, just set the single value, ignore undefined
            else if (value !== undefined) {
                const isColor = targetProp instanceof THREE.Color;
                // allow setting array scalars
                if (!isColor && targetProp['setScalar']) targetProp['setScalar'](value);
                // layers have no copy function, copy the mask
                else if (targetProp instanceof THREE.Layers && value instanceof THREE.Layers)
                    targetProp.mask = value.mask;
                // otherwise just set ...
                else targetProp['set'](value);

                // auto-convert srgb
                if (!THREE.ColorManagement && !rootState?.linear && isColor) targetProp.convertSRGBToLinear();
            }
        }
        // else just overwrite the value
        else {
            currentInstance[key] = value;
            // auto-convert srgb textures
            if (!rootState?.linear && currentInstance[key] instanceof THREE.Texture) {
                currentInstance[key]['encoding'] = THREE.sRGBEncoding;
            }
        }

        checkUpdate(targetProp);
        invalidateInstance(instance);
    }

    const instanceHandlers = localState.eventCount;

    if (localState.parent && rootState.internal && instance['raycast'] && instanceHandlers !== localState.eventCount) {
        // pre-emptively remove the interaction from manager
        rootState.removeInteraction(instance['uuid']);
        // add the instance to the interaction manager only when it has handlers
        if (localState.eventCount) rootState.addInteraction(instance);
    }

    if (localState.parent && localState.afterUpdate && localState.afterUpdate.observed && changes.length) {
        localState.afterUpdate.emit(instance);
    }

    return instance;
}
