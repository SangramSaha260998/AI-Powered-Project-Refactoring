import { Routes } from "@angular/router";
import { viewPermissionResolverFn } from "@app/core/resolvers";

export const routes: Routes = [
  {
    path: "",
    pathMatch: "full",
    redirectTo: "",
  },
  {
    path: "dashboard",
    title: "Home Level Dashboard",
    resolve: { data: viewPermissionResolverFn },
    loadComponent: () =>
      import("./dashboard/pages").then((c) => c.DashboardComponent),
  },
];
