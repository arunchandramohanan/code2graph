import { Routes } from '@angular/router';

import { OrderListComponent } from './orders/order-list.component';
import { CustomerListComponent } from './customers/customer-list.component';

export const routes: Routes = [
  { path: '', redirectTo: 'orders', pathMatch: 'full' },
  { path: 'orders', component: OrderListComponent },
  {
    path: 'orders/:id',
    loadComponent: () =>
      import('./orders/order-detail.component').then((m) => m.OrderDetailComponent),
  },
  { path: 'customers', component: CustomerListComponent },
];
