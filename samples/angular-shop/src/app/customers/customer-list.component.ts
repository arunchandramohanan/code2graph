import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

import { Customer, CustomerService } from './customer.service';

@Component({
  selector: 'app-customer-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    <h2>Customers</h2>
    <table>
      <tr *ngFor="let c of customers" (click)="select(c)">
        <td>{{ c.fullName }}</td>
        <td>{{ c.email }}</td>
        <td>{{ c.orderCount }}</td>
      </tr>
    </table>
  `,
})
export class CustomerListComponent implements OnInit {
  customers: Customer[] = [];
  selected?: Customer;

  constructor(private customerService: CustomerService) {}

  ngOnInit(): void {
    this.customerService.list().subscribe((customers) => (this.customers = customers));
  }

  select(customer: Customer): void {
    this.selected = customer;
  }
}
