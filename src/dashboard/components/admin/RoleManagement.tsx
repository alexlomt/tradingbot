import React, { useState, useEffect } from 'react';
import {
    Box,
    Paper,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Button,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField,
    Checkbox,
    FormGroup,
    FormControlLabel,
    Typography,
    Alert,
    IconButton,
    Tooltip,
    Grid
} from '@mui/material';
import {
    Edit as EditIcon,
    Delete as DeleteIcon,
    Add as AddIcon
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { RoleService } from '../../services/RoleService';
import { Role, Permission } from '../../types';

export const RoleManagement: React.FC = () => {
    const { hasPermission } = usePermissions();
    const [roles, setRoles] = useState<Role[]>([]);
    const [permissions, setPermissions] = useState<Permission[]>([]);
    const [selectedRole, setSelectedRole] = useState<Role | null>(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [isNewRole, setIsNewRole] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        loadRolesAndPermissions();
    }, []);

    const loadRolesAndPermissions = async () => {
        try {
            const [rolesResponse, permissionsResponse] = await Promise.all([
                RoleService.getAllRoles(),
                RoleService.getAllPermissions()
            ]);
            setRoles(rolesResponse.data);
            setPermissions(permissionsResponse.data);
        } catch (err) {
            setError('Failed to load roles and permissions');
        }
    };

    const handleCreateRole = () => {
        setSelectedRole({
            id: '',
            name: '',
            description: '',
            permissions: [],
            createdAt: new Date(),
            updatedAt: new Date()
        });
        setIsNewRole(true);
        setIsDialogOpen(true);
    };

    const handleEditRole = (role: Role) => {
        setSelectedRole(role);
        setIsNewRole(false);
        setIsDialogOpen(true);
    };

    const handleDeleteRole = async (roleId: string) => {
        if (!hasPermission('MANAGE_ROLES')) return;
        
        if (window.confirm('Are you sure you want to delete this role?')) {
            try {
                await RoleService.deleteRole(roleId);
                await loadRolesAndPermissions();
            } catch (err) {
                setError('Failed to delete role');
            }
        }
    };

    const handleSaveRole = async () => {
        if (!selectedRole) return;

        try {
            if (isNewRole) {
                await RoleService.createRole(selectedRole);
            } else {
                await RoleService.updateRole(selectedRole.id, selectedRole);
            }
            setIsDialogOpen(false);
            await loadRolesAndPermissions();
        } catch (err) {
            setError('Failed to save role');
        }
    };

    const handlePermissionToggle = (permission: Permission) => {
        if (!selectedRole) return;

        const hasPermission = selectedRole.permissions.some(p => p.id === permission.id);
        const updatedPermissions = hasPermission
            ? selectedRole.permissions.filter(p => p.id !== permission.id)
            : [...selectedRole.permissions, permission];

        setSelectedRole({
            ...selectedRole,
            permissions: updatedPermissions
        });
    };

    return (
        <Box sx={{ width: '100%', p: 3 }}>
            {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {error}
                </Alert>
            )}

            <Box sx={{ mb: 2, display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={handleCreateRole}
                    disabled={!hasPermission('MANAGE_ROLES')}
                >
                    Create Role
                </Button>
            </Box>

            <Paper sx={{ width: '100%', mb: 2 }}>
                <TableContainer>
                    <Table>
                        <TableHead>
                            <TableRow>
                                <TableCell>Name</TableCell>
                                <TableCell>Description</TableCell>
                                <TableCell>Permissions</TableCell>
                                <TableCell>Actions</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {roles.map((role) => (
                                <TableRow key={role.id}>
                                    <TableCell>{role.name}</TableCell>
                                    <TableCell>{role.description}</TableCell>
                                    <TableCell>
                                        {role.permissions.length} permissions
                                    </TableCell>
                                    <TableCell>
                                        <Tooltip title="Edit Role">
                                            <IconButton
                                                onClick={() => handleEditRole(role)}
                                                disabled={!hasPermission('MANAGE_ROLES')}
                                            >
                                                <EditIcon />
                                            </IconButton>
                                        </Tooltip>
                                        
                                        {role.name !== 'SUPER_ADMIN' && (
                                            <Tooltip title="Delete Role">
                                                <IconButton
                                                    onClick={() => handleDeleteRole(role.id)}
                                                    disabled={!hasPermission('MANAGE_ROLES')}
                                                    color="error"
                                                >
                                                    <DeleteIcon />
                                                </IconButton>
                                            </Tooltip>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            <Dialog 
                open={isDialogOpen} 
                onClose={() => setIsDialogOpen(false)}
                maxWidth="md"
                fullWidth
            >
                <DialogTitle>
                    {isNewRole ? 'Create Role' : 'Edit Role'}
                </DialogTitle>
                <DialogContent>
                    {selectedRole && (
                        <Box sx={{ pt: 2 }}>
                            <TextField
                                fullWidth
                                label="Name"
                                value={selectedRole.name}
                                onChange={(e) => setSelectedRole({
                                    ...selectedRole,
                                    name: e.target.value
                                })}
                                sx={{ mb: 2 }}
                            />
                            
                            <TextField
                                fullWidth
                                label="Description"
                                value={selectedRole.description}
                                onChange={(e) => setSelectedRole({
                                    ...selectedRole,
                                    description: e.target.value
                                })}
                                sx={{ mb: 3 }}
                            />

                            <Typography variant="h6" sx={{ mb: 2 }}>
                                Permissions
                            </Typography>

                            <Grid container spacing={2}>
                                {permissions.map((permission) => (
                                    <Grid item xs={6} key={permission.id}>
                                        <FormControlLabel
                                            control={
                                                <Checkbox
                                                    checked={selectedRole.permissions.some(
                                                        p => p.id === permission.id
                                                    )}
                                                    onChange={() => handlePermissionToggle(permission)}
                                                />
                                            }
                                            label={permission.name}
                                        />
                                    </Grid>
                                ))}
                            </Grid>
                        </Box>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setIsDialogOpen(false)}>
                        Cancel
                    </Button>
                    <Button 
                        onClick={handleSaveRole}
                        variant="contained"
                        disabled={!selectedRole?.name}
                    >
                        Save
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};
