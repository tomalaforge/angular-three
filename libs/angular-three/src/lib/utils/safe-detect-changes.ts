import { ChangeDetectorRef } from '@angular/core';
import { NgtAnyRecord } from '../types';

export function safeDetectChanges(cdr: ChangeDetectorRef | null) {
    if (!cdr) return;
    try {
        if ((cdr as NgtAnyRecord)['context']) {
            cdr.detectChanges();
        }
    } catch (e) {
        cdr.markForCheck();
    }
}
